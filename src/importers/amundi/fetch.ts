#!/usr/bin/env bun
/**
 * CLI for fetching Amundi investment data via their API.
 *
 * Usage:
 *   bun run src/importers/amundi/fetch.ts --contract <number>
 *   bun run src/importers/amundi/fetch.ts --contract <number> --step
 *
 * Environment variables:
 *   AMUNDI_USERNAME       — Keycloak username (for password grant)
 *   AMUNDI_PASSWORD       — Keycloak password
 *   AMUNDI_CLIENT_ID      — Keycloak client_id (default: prd-nma-215640)
 *   AMUNDI_CONTRACT       — Contract number
 *
 * Authentication is interactive: you choose between stored credentials
 * (from env/1Password) or pasting a Bearer token from browser devtools.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { config } from "../../config.ts";
import { requireRealData } from "../utils.ts";
import {
	type AmundiTrade,
	authenticate,
	extractMojeIdFromToken,
	fetchAllCashflow,
	fetchAllOrders,
	fetchAllTrades,
	fetchClient,
	fetchContracts,
	fetchFundList,
} from "./api.ts";

function main() {
	const { values } = parseArgs({
		options: {
			contract: { type: "string", short: "c" },
			step: { type: "boolean", short: "s", default: false },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
	});

	if (values.help) {
		console.log(`Usage: bun run src/importers/amundi/fetch.ts [options]

Options:
  -c, --contract NUMBER  Contract number
  -s, --step             Pause and confirm before each API call
  -h, --help             Show this help

Environment:
  AMUNDI_USERNAME        Keycloak username (for password auth)
  AMUNDI_PASSWORD        Keycloak password
  AMUNDI_CLIENT_ID       Keycloak client_id (default: prd-nma-215640)
  AMUNDI_CONTRACT        Contract number (alternative to --contract)

Quick start:
  1. Set AMUNDI_USERNAME and AMUNDI_PASSWORD in .env (or inject via 1Password)
  2. Run: bun run src/importers/amundi/fetch.ts --contract <number>

Or paste a Bearer token interactively (grab from browser devtools, Network tab).

First time? Use --step to pause between each API call.
`);
		process.exit(0);
	}

	requireRealData();

	return run(values.contract, values.step ?? false);
}

async function prompt(message: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(message, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function confirm(message: string): Promise<boolean> {
	const answer = await prompt(`${message} [Y/n] `);
	const a = answer.toLowerCase();
	return a === "" || a === "y" || a === "yes";
}

async function run(contractArg?: string, step = false) {
	const outDir = join(config.rawPath, "amundi");
	if (!existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}

	const token = await resolveToken();

	// Resolve client + contract
	const { contractNumber, clientId } = await resolveContract(
		token,
		contractArg,
		step,
	);

	// Orders
	if (step) {
		console.log("\n\u2500\u2500 Step 2: Fetch all orders (paginated)");
		if (!(await confirm("Proceed?"))) {
			console.log("Stopped.");
			return;
		}
	}

	console.log("\nFetching orders...");
	const orders = await fetchAllOrders(token, contractNumber);
	console.log(`  \u2713 ${orders.length} orders total`);

	const finishedOrders = orders.filter((o) => o.statusCode === "FINISHED");
	const otherStatuses = orders.filter((o) => o.statusCode !== "FINISHED");
	console.log(`  ${finishedOrders.length} finished`);
	if (otherStatuses.length > 0) {
		const statusCounts = new Map<string, number>();
		for (const o of otherStatuses) {
			statusCounts.set(o.statusCode, (statusCounts.get(o.statusCode) ?? 0) + 1);
		}
		for (const [status, count] of statusCounts) {
			console.log(`  ${count} ${status.toLowerCase()}`);
		}
	}

	// Save orders (needed for fee calculation: orderAmount vs tradedAmount)
	const ordersFile = join(outDir, "orders.json");
	writeFileSync(ordersFile, JSON.stringify(finishedOrders, null, "\t"));
	console.log(`  Saved to ${ordersFile}`);

	if (finishedOrders.length === 0) {
		console.log("No finished orders found.");
		return;
	}

	const orderIds = finishedOrders.map((o) => o.orderId);

	// Trades
	if (step) {
		console.log(
			`\n\u2500\u2500 Step 3: Fetch trades for ${orderIds.length} orders (batched)`,
		);
		if (!(await confirm("Proceed?"))) {
			console.log("Stopped.");
			return;
		}
	}

	console.log("\nFetching trades...");
	const batchSize = 30;
	const trades = await fetchAllTrades(token, clientId, orderIds, batchSize);
	console.log(`  \u2713 ${trades.length} trades`);

	// Summary by fund
	const byFund = new Map<string, AmundiTrade[]>();
	for (const trade of trades) {
		const existing = byFund.get(trade.fundIsin) ?? [];
		existing.push(trade);
		byFund.set(trade.fundIsin, existing);
	}
	for (const [, fundTrades] of byFund) {
		const name = fundTrades[0]?.fundName ?? "unknown";
		const totalUnits = fundTrades.reduce((s, t) => {
			const sign = t.directionCode === "BUY" ? 1 : -1;
			return s + sign * t.tradedQuantity;
		}, 0);
		const totalAmount = fundTrades.reduce((s, t) => {
			const sign = t.directionCode === "BUY" ? 1 : -1;
			return s + sign * t.tradedAmount.value;
		}, 0);
		console.log(
			`  ${name}: ${fundTrades.length} trades, ${totalUnits} units, ${totalAmount.toFixed(2)} ${fundTrades[0]?.tradedAmount.currency}`,
		);
	}

	// Save trades
	trades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
	const tradesFile = join(outDir, "trades.json");
	if (existsSync(tradesFile)) {
		try {
			const existingTrades = JSON.parse(
				readFileSync(tradesFile, "utf-8"),
			) as AmundiTrade[];
			const existingIds = new Set(existingTrades.map((t) => t.tradeId));
			const newTrades = trades.filter((t) => !existingIds.has(t.tradeId));
			if (newTrades.length > 0) {
				console.log(`  ${newTrades.length} new trades since last fetch`);
			}
		} catch {
			// Ignore read errors on existing file
		}
	}
	writeFileSync(tradesFile, JSON.stringify(trades, null, "\t"));
	console.log(`  Saved to ${tradesFile}`);

	// Fund metadata (uses ISINs discovered from trades)
	const isins = [...byFund.keys()];
	if (step) {
		console.log(
			`\n\u2500\u2500 Step 4: Fetch fund metadata for ${isins.length} ISIN(s)`,
		);
		if (!(await confirm("Proceed?"))) {
			console.log("Stopped. trades.json saved \u2014 enough for the importer.");
			return;
		}
	}

	console.log("\nFetching fund metadata...");
	const fundListResponse = await fetchFundList(token, isins, clientId);
	const funds = fundListResponse.fundList;
	console.log(`  \u2713 ${funds.length} fund(s)`);
	const fundsFile = join(outDir, "funds.json");
	writeFileSync(fundsFile, JSON.stringify(funds, null, "\t"));
	console.log(`  Saved to ${fundsFile}`);

	// Cashflow
	if (step) {
		console.log("\n\u2500\u2500 Step 5: Fetch cashflow (paginated)");
		if (!(await confirm("Proceed?"))) {
			console.log("Stopped. trades.json and funds.json saved.");
			return;
		}
	}

	console.log("\nFetching cashflow...");
	const cashflows = await fetchAllCashflow(token, contractNumber);
	console.log(`  \u2713 ${cashflows.length} cashflow entries`);

	const totalIn = cashflows
		.filter((c) => c.directionCode === "IN")
		.reduce((s, c) => s + c.cashflowAmount.value, 0);
	const totalOut = cashflows
		.filter((c) => c.directionCode === "OUT")
		.reduce((s, c) => s + c.cashflowAmount.value, 0);
	console.log(
		`  Deposits: ${totalIn.toFixed(0)} CZK, withdrawals: ${totalOut.toFixed(0)} CZK`,
	);

	cashflows.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
	const cashflowFile = join(outDir, "cashflow.json");
	writeFileSync(cashflowFile, JSON.stringify(cashflows, null, "\t"));
	console.log(`  Saved to ${cashflowFile}`);

	// Summary
	console.log("\n\u2500\u2500 Done");
	console.log(`  ${trades.length} trades across ${byFund.size} fund(s)`);
	console.log(`  ${cashflows.length} cashflow entries`);
	console.log(`  Data saved to ${outDir}/`);
	console.log("  Run `bun run build` to regenerate beancount output.");
}

async function resolveToken(): Promise<string> {
	const username = process.env.AMUNDI_USERNAME;
	const password = process.env.AMUNDI_PASSWORD;

	if (username && password) {
		if (username.startsWith("op://") || password.startsWith("op://")) {
			console.error(
				"AMUNDI_USERNAME/PASSWORD contain 1Password references (op://).\n" +
					"Run via `op run --env-file .env` to inject secrets.",
			);
			process.exit(1);
		}
		const clientId = process.env.AMUNDI_CLIENT_ID ?? "prd-nma-215640";
		console.log(`Authenticating as ${username}...`);
		const tokenResponse = await authenticate(username, password, clientId);
		console.log(`  ✓ Token obtained (expires in ${tokenResponse.expires_in}s)`);
		return tokenResponse.access_token;
	}

	// No credentials in env — fall back to manual token
	console.log("No AMUNDI_USERNAME/AMUNDI_PASSWORD in environment.");
	return promptForToken();
}

async function promptForToken(): Promise<string> {
	console.log(
		"Grab a Bearer token from browser devtools (Network tab → Authorization header).",
	);
	const token = await prompt("Bearer token: ");
	if (!token) {
		console.error("No token provided.");
		process.exit(1);
	}
	return token;
}

async function resolveContract(
	token: string,
	contractArg: string | undefined,
	step: boolean,
): Promise<{ contractNumber: string; clientId: string }> {
	const mojeId = extractMojeIdFromToken(token);
	if (!mojeId) {
		console.error("Could not extract mojeIdentifier from token.");
		process.exit(1);
	}

	if (step) {
		console.log("\n── Step 1: Resolve client and contract");
		if (!(await confirm("Proceed?"))) {
			console.log("Stopped.");
			process.exit(0);
		}
	}

	console.log("\nResolving client...");
	const clientResponse = await fetchClient(token, mojeId);
	const client = clientResponse.clientDetail[0];
	if (!client) {
		console.error(
			`No client found. API response: ${JSON.stringify(clientResponse)}`,
		);
		process.exit(1);
	}
	const clientId = client.clientId;
	console.log(`  ✓ clientId: ${clientId}`);

	const explicit = contractArg ?? process.env.AMUNDI_CONTRACT;
	if (explicit) {
		console.log(`  Contract: ${explicit} (from config)`);
		return { contractNumber: explicit, clientId };
	}

	console.log("Fetching contracts...");
	const contractResponse = await fetchContracts(token, clientId);
	const active = contractResponse.contractList.filter(
		(c) => c.statusCode === "ACTIVE",
	);

	if (active.length === 0) {
		console.error("No active contracts found.");
		process.exit(1);
	}

	if (active.length === 1) {
		const contract = active[0] as (typeof active)[0];
		console.log(
			`  ✓ ${contract.contractNumber} — ${contract.contractTypeMarketingName} (${contract.name})`,
		);
		return { contractNumber: contract.contractNumber, clientId };
	}

	console.log("  Multiple active contracts:");
	for (const [i, c] of active.entries()) {
		console.log(
			`  ${i + 1}. ${c.contractNumber} — ${c.contractTypeMarketingName} (${c.name})`,
		);
	}
	const choice = await prompt("Choose contract [1]: ");
	const idx = (choice ? Number.parseInt(choice, 10) : 1) - 1;
	const chosen = active[idx];
	if (!chosen) {
		console.error("Invalid choice.");
		process.exit(1);
	}
	return { contractNumber: chosen.contractNumber, clientId };
}

if (import.meta.main) {
	main();
}
