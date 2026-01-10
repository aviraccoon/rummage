#!/usr/bin/env bun
/**
 * CLI for fetching Fio banka transactions via their token-based API.
 *
 * Usage:
 *   bun run src/importers/fio/fetch.ts                      # All FIO_TOKEN_* accounts
 *   bun run src/importers/fio/fetch.ts --account PERSONAL   # Just one account
 *   bun run src/importers/fio/fetch.ts --incremental        # Since last fetch
 *   bun run src/importers/fio/fetch.ts --from 2024-01-01    # From specific date
 *
 * Environment variables:
 *   FIO_TOKEN_PERSONAL=...   # Each FIO_TOKEN_* is a separate account
 *   FIO_TOKEN_BUSINESS=...
 *   FIO_TOKEN_SAVINGS=...
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../../config.ts";
import { requireRealData, sleep } from "../utils.ts";
import {
	DEFAULT_DAYS,
	extractTransactions,
	fetchTransactions,
	formatDate,
	getDateDaysAgo,
	isValidToken,
	setLastDownloadDate,
	simplifyTransaction,
} from "./api.ts";

/** Account with name and token */
export interface Account {
	name: string;
	token: string;
}

/** Discover all FIO_TOKEN_* environment variables */
export function discoverAccounts(): Account[] {
	const accounts: Account[] = [];
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("FIO_TOKEN_") && value) {
			const name = key.replace("FIO_TOKEN_", "").toLowerCase();
			accounts.push({ name, token: value });
		}
	}
	return accounts;
}

/** Filter accounts by name (case-insensitive) */
export function filterAccounts(
	accounts: Account[],
	requestedAccount: string | undefined,
): Account[] {
	if (!requestedAccount) return accounts;
	const lower = requestedAccount.toLowerCase();
	return accounts.filter((a) => a.name === lower);
}

/** Build output filename from account info */
export function buildOutputFilename(
	currency: string,
	dateStart: string,
	dateEnd: string,
): string {
	return `${currency}_${dateStart}_${dateEnd}.json`;
}

/** Build account output directory path (e.g., raw/fio-personal) */
export function buildAccountDir(rawDir: string, accountName: string): string {
	return join(rawDir, `fio-${accountName}`);
}

/** Format a sample transaction for display */
export function formatSampleTransaction(simple: {
	date: string;
	amount: number;
	currency: string;
	userIdentification: string | null;
	type: string;
}): string {
	const sign = simple.amount > 0 ? "+" : "";
	const desc = simple.userIdentification ?? simple.type;
	return `${simple.date} ${sign}${simple.amount} ${simple.currency} - ${desc}`;
}

/** Fetch and save transactions for a single account */
async function fetchAccount(
	name: string,
	token: string,
	options: { from?: string; to?: string; incremental?: boolean },
	rawDir: string,
): Promise<{ success: boolean; transactions: number }> {
	const data = await fetchTransactions(token, options);
	const info = data.accountStatement.info;
	const transactions = extractTransactions(data);

	console.log(`\n✓ ${name}: ${info.iban} (${info.currency})`);
	console.log(`  Period: ${info.dateStart} to ${info.dateEnd}`);
	console.log(`  Transactions: ${transactions.length}`);
	console.log(
		`  Balance: ${info.openingBalance.toFixed(2)} → ${info.closingBalance.toFixed(2)} ${info.currency}`,
	);

	if (transactions.length === 0) {
		return { success: true, transactions: 0 };
	}

	// Ensure output directory exists (per account)
	const accountDir = buildAccountDir(rawDir, name);
	if (!existsSync(accountDir)) {
		mkdirSync(accountDir, { recursive: true });
	}

	// Save to file with date range in filename
	const fileName = buildOutputFilename(
		info.currency,
		info.dateStart,
		info.dateEnd,
	);
	const filePath = join(accountDir, fileName);

	writeFileSync(filePath, JSON.stringify(data, null, "\t"));
	console.log(`  Saved to ${filePath}`);

	// Show sample transaction
	const sample = transactions[0];
	if (sample) {
		const simple = simplifyTransaction(sample);
		console.log(`  Sample: ${formatSampleTransaction(simple)}`);
	}

	return { success: true, transactions: transactions.length };
}

async function main() {
	requireRealData();
	const RAW_DIR = config.rawPath;

	console.log("🦝 Fio Banka Transaction Fetcher\n");

	// Parse command line arguments
	const { values } = parseArgs({
		options: {
			account: { type: "string", short: "a" },
			from: { type: "string", short: "f" },
			to: { type: "string", short: "t" },
			incremental: { type: "boolean", short: "i", default: false },
			"reset-marker": { type: "string", short: "r" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
	});

	if (values.help) {
		console.log(`Usage: bun run src/importers/fio/fetch.ts [options]

Options:
  -a, --account NAME    Fetch only this account (matches FIO_TOKEN_NAME)
  -i, --incremental     Fetch only new transactions since last download
  -f, --from DATE       Start date (YYYY-MM-DD), defaults to ${DEFAULT_DAYS} days ago
  -t, --to DATE         End date (YYYY-MM-DD), defaults to today
  -r, --reset-marker    Reset the server-side "last download" marker to DATE
  -h, --help            Show this help

Environment:
  FIO_TOKEN_PERSONAL    Token for "personal" account
  FIO_TOKEN_BUSINESS    Token for "business" account
  (any FIO_TOKEN_* pattern works)

Examples:
  fetch.ts                          # All accounts, last ${DEFAULT_DAYS} days
  fetch.ts --account personal       # Just the personal account
  fetch.ts --incremental            # Since last fetch (server tracks this)
  fetch.ts --from 2024-01-01        # From specific date (may need auth for >90 days)

Note: Fio rate-limits to 30s between requests per token.
Data older than 90 days requires manual authorization at ib.fio.cz.
`);
		process.exit(0);
	}

	// Discover accounts
	const allAccounts = discoverAccounts();

	if (allAccounts.length === 0) {
		console.error("Error: No FIO_TOKEN_* environment variables found.\n");
		console.error("To get a token:");
		console.error("  1. Login to https://ib.fio.cz");
		console.error("  2. Go to Nastavení → API");
		console.error("  3. Generate a new token\n");
		console.error("Add to your .env file:");
		console.error("  FIO_TOKEN_PERSONAL=your-64-character-token");
		console.error("  FIO_TOKEN_BUSINESS=another-token");
		process.exit(1);
	}

	// Filter to specific account if requested
	const accounts = filterAccounts(allAccounts, values.account);

	if (accounts.length === 0) {
		console.error(`Error: Account "${values.account}" not found.\n`);
		console.error("Available accounts:");
		for (const a of allAccounts) {
			console.error(`  - ${a.name} (FIO_TOKEN_${a.name.toUpperCase()})`);
		}
		process.exit(1);
	}

	// Validate tokens
	for (const { name, token } of accounts) {
		if (!isValidToken(token)) {
			console.error(
				`Warning: Token for ${name} doesn't look valid (expected 64 alphanumeric characters, got ${token.length}).`,
			);
		}
	}

	// Handle reset-marker command
	if (values["reset-marker"]) {
		for (const { name, token } of accounts) {
			console.log(
				`Resetting marker for ${name} to ${values["reset-marker"]}...`,
			);
			try {
				await setLastDownloadDate(token, values["reset-marker"]);
				console.log(`✓ ${name}: Marker reset.`);
			} catch (error) {
				console.error(
					`✗ ${name}: ${error instanceof Error ? error.message : error}`,
				);
			}
		}
		return;
	}

	// Fetch transactions
	const fetchOptions = {
		from: values.from,
		to: values.to,
		incremental: values.incremental,
	};

	const defaultFrom = getDateDaysAgo(DEFAULT_DAYS);
	const defaultTo = formatDate(new Date());

	console.log(`Accounts: ${accounts.map((a) => a.name).join(", ")}`);
	console.log(
		values.incremental
			? "Mode: incremental (since last download)"
			: `Period: ${values.from ?? defaultFrom} to ${values.to ?? defaultTo}`,
	);

	let totalTransactions = 0;
	let failures = 0;

	for (let i = 0; i < accounts.length; i++) {
		const account = accounts[i];
		if (!account) continue;

		// Rate limit: wait 30s between requests (except first)
		if (i > 0) {
			console.log("\n⏳ Waiting 30s (Fio rate limit)...");
			await sleep(30000);
		}

		try {
			const result = await fetchAccount(
				account.name,
				account.token,
				fetchOptions,
				RAW_DIR,
			);
			totalTransactions += result.transactions;
		} catch (error) {
			console.error(
				`\n✗ ${account.name}: ${error instanceof Error ? error.message : error}`,
			);
			failures++;
		}
	}

	console.log(`\n${"─".repeat(40)}`);
	console.log(
		`Total: ${totalTransactions} transactions from ${accounts.length - failures}/${accounts.length} accounts`,
	);

	if (failures > 0) {
		process.exit(1);
	}
}

// Only run when executed directly, not when imported
if (import.meta.main) {
	main();
}
