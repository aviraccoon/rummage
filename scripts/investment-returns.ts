#!/usr/bin/env bun
/**
 * Investment returns report — shows true total return including acquisition costs.
 *
 * Fava's Holdings view only shows unrealized gain on cost basis, hiding entry fees
 * and other acquisition costs. This script combines holdings market value with
 * associated fee expenses to show the full picture.
 *
 * Usage:
 *   bun scripts/investment-returns.ts
 *   bun scripts/investment-returns.ts /path/to/main.beancount
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_PATH } from "../src/config.ts";

const beancountFile =
	process.argv[2] ?? join(DATA_PATH, "generated", "main.beancount");

if (!existsSync(beancountFile)) {
	console.error(`File not found: ${beancountFile}`);
	process.exit(1);
}

// ── Bean-query helpers ──

function beanQuery(query: string): string {
	const escaped = query.replace(/"/g, '\\"');
	return execSync(`bean-query "${beancountFile}" "${escaped}"`, {
		encoding: "utf-8",
	});
}

function parseAmount(text: string): { value: number; currency: string } {
	const match = text.trim().match(/^(-?[\d,.]+)\s+(\S+)/);
	if (!match) return { value: 0, currency: "" };
	return {
		value: Number.parseFloat(match[1]?.replace(",", "") ?? "0"),
		currency: match[2] ?? "",
	};
}

function extractDate(output: string): string {
	const match = output.match(/(\d{4}-\d{2}-\d{2})/);
	return match?.[1] ?? "";
}

function queryAmount(query: string): { value: number; currency: string } {
	const output = beanQuery(query);
	const lines = output
		.split("\n")
		.filter((l) => l.trim() && !l.includes("---") && !l.includes("sum("));
	const dataLine = lines[lines.length - 1];
	return dataLine ? parseAmount(dataLine) : { value: 0, currency: "" };
}

// ── Currency detection ──

function detectCurrency(): string {
	// Look at what currency the investment fees are in
	const result = queryAmount(
		"SELECT sum(position) WHERE account ~ 'Finance:Investments:Fees'",
	);
	if (result.currency) return result.currency;

	// Fallback: most common currency in price directives
	const content = readFileSync(beancountFile, "utf-8");
	const currencies = new Map<string, number>();
	for (const match of content.matchAll(
		/^\d{4}-\d{2}-\d{2}\s+price\s+\S+\s+[\d.]+\s+(\S+)$/gm,
	)) {
		const c = match[1];
		if (c) currencies.set(c, (currencies.get(c) ?? 0) + 1);
	}
	let best = "CZK";
	let bestCount = 0;
	for (const [c, n] of currencies) {
		if (n > bestCount) {
			best = c;
			bestCount = n;
		}
	}
	return best;
}

// ── Investment discovery ──

interface Investment {
	name: string;
	assetPattern: string;
	feePayee: string;
	roundingPattern: string;
}

function discoverInvestments(): Investment[] {
	const output = beanQuery(
		"SELECT DISTINCT account WHERE account ~ '^Assets:Investments:' AND account !~ ':Cash$'",
	);

	const investmentNames = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("Assets:Investments:")) continue;
		const name = trimmed.split(":")[2];
		if (name) investmentNames.add(name);
	}

	return [...investmentNames].map((name) => ({
		name,
		assetPattern: `^Assets:Investments:${name}`,
		feePayee: name,
		roundingPattern: `Investments:${name}:Rounding`,
	}));
}

// ── Data fetching ──

interface InvestmentData {
	name: string;
	currency: string;
	costBasis: number;
	marketValue: number;
	cashBalance: number;
	fees: number;
	rounding: number;
	totalDeposited: number;
	unrealizedGain: number;
	unrealizedPct: number;
	totalReturn: number;
	totalReturnPct: number;
	firstDate: string;
	lastDate: string;
	durationYears: number;
	feePct: number;
}

function getInvestmentData(inv: Investment): InvestmentData {
	const costBasis = queryAmount(
		`SELECT sum(cost(position)) WHERE account ~ '${inv.assetPattern}' AND account !~ ':Cash$'`,
	);

	const marketValue = queryAmount(
		`SELECT sum(value(position)) WHERE account ~ '${inv.assetPattern}' AND account !~ ':Cash$'`,
	);

	const cashBalance = queryAmount(
		`SELECT sum(cost(position)) WHERE account ~ '${inv.assetPattern}:Cash$'`,
	);

	const fees = queryAmount(
		`SELECT sum(position) WHERE account = 'Expenses:Finance:Investments:Fees' AND payee = '${inv.feePayee}'`,
	);

	const rounding = queryAmount(
		`SELECT sum(position) WHERE account ~ '${inv.roundingPattern}'`,
	);

	// Date range from transactions touching this investment's accounts
	const firstDateResult = beanQuery(
		`SELECT min(date) WHERE account ~ '${inv.assetPattern}'`,
	);
	const lastDateResult = beanQuery(
		`SELECT max(date) WHERE account ~ '${inv.assetPattern}'`,
	);
	const firstDate = extractDate(firstDateResult);
	const lastDate = extractDate(lastDateResult);

	const durationMs = Date.now() - new Date(firstDate).getTime();
	const durationYears = durationMs / (1000 * 60 * 60 * 24 * 365.25);

	const currency = costBasis.currency || marketValue.currency || "CZK";

	// Total deposited = cost basis + fees + rounding absorbed + cash balance
	const totalDeposited =
		costBasis.value + fees.value - rounding.value + cashBalance.value;

	const unrealizedGain = marketValue.value - costBasis.value;
	const unrealizedPct =
		costBasis.value > 0 ? (unrealizedGain / costBasis.value) * 100 : 0;

	// Total return = current holdings (market + cash) - total deposited
	const currentTotal = marketValue.value + cashBalance.value;
	const totalReturn = currentTotal - totalDeposited;
	const totalReturnPct =
		totalDeposited > 0 ? (totalReturn / totalDeposited) * 100 : 0;

	const feePct = totalDeposited > 0 ? (fees.value / totalDeposited) * 100 : 0;

	return {
		name: inv.name,
		currency,
		costBasis: costBasis.value,
		marketValue: marketValue.value,
		cashBalance: cashBalance.value,
		fees: fees.value,
		rounding: rounding.value,
		totalDeposited,
		unrealizedGain,
		unrealizedPct,
		totalReturn,
		totalReturnPct,
		firstDate,
		lastDate,
		durationYears,
		feePct,
	};
}

// ── Output ──

function fmtAmt(value: number, currency: string): string {
	const formatted = Math.abs(value).toLocaleString("cs-CZ", {
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	});
	const sign = value < 0 ? "-" : "";
	return `${sign}${formatted} ${currency}`;
}

function fmtPct(value: number): string {
	const sign = value >= 0 ? "+" : "";
	return `${sign}${value.toFixed(1)}%`;
}

function fmtDuration(years: number): string {
	const y = Math.floor(years);
	const m = Math.round((years - y) * 12);
	if (y === 0) return `${m} months`;
	if (m === 0) return `${y} years`;
	return `${y}y ${m}m`;
}

function printInvestment(data: InvestmentData): void {
	const c = data.currency;
	const pad = 15;

	console.log(`\n${"─".repeat(55)}`);
	console.log(
		`  ${data.name}  (${data.firstDate} → now, ${fmtDuration(data.durationYears)})`,
	);
	console.log(`${"─".repeat(55)}`);
	console.log(
		`  Total paid in:    ${fmtAmt(data.totalDeposited, c).padStart(pad)}  (deposits)`,
	);
	console.log(
		`    → Buying units: ${fmtAmt(data.costBasis, c).padStart(pad)}  (cost basis)`,
	);
	if (data.fees > 0) {
		console.log(`    → Entry fees:   ${fmtAmt(data.fees, c).padStart(pad)}`);
	}
	if (data.cashBalance !== 0) {
		console.log(
			`    → Cash balance: ${fmtAmt(data.cashBalance, c).padStart(pad)}  (uninvested)`,
		);
	}
	if (Math.abs(data.rounding) > 0.01) {
		console.log(
			`    → Rounding:     ${fmtAmt(-data.rounding, c).padStart(pad)}`,
		);
	}
	console.log();
	console.log(
		`  Worth today:      ${fmtAmt(data.marketValue, c).padStart(pad)}  (market value)`,
	);
	console.log(
		`  Fund gained:      ${fmtAmt(data.unrealizedGain, c).padStart(pad)}  (${fmtPct(data.unrealizedPct)} unrealized gain on cost basis)`,
	);
	console.log(
		`  You gained:       ${fmtAmt(data.totalReturn, c).padStart(pad)}  (${fmtPct(data.totalReturnPct)} total return on deposits)`,
	);
	if (data.fees > 0) {
		console.log(
			`  Lost to fees:     ${fmtPct(data.feePct).padStart(pad - 1)}   of your money went to fees, not investing (fee drag)`,
		);
	}
	if (data.totalReturn < 0 && data.unrealizedGain > 0) {
		// Estimate breakeven: need totalReturn more growth on current market value
		const neededGrowth = -data.totalReturn / data.marketValue;
		// Use recent fund performance (annualized unrealized gain)
		const annualizedFundReturn =
			data.durationYears > 0
				? (data.marketValue / data.costBasis) ** (1 / data.durationYears) - 1
				: 0;
		if (annualizedFundReturn > 0) {
			const yearsToBreakeven =
				Math.log(1 + neededGrowth) / Math.log(1 + annualizedFundReturn);
			const breakevenDate = new Date(
				Date.now() + yearsToBreakeven * 365.25 * 24 * 60 * 60 * 1000,
			);
			console.log(
				`  Breakeven est:    ~${fmtDuration(yearsToBreakeven)} (${breakevenDate.toISOString().slice(0, 7)}), if the fund keeps growing ${fmtPct(annualizedFundReturn * 100).trim()}/yr (CAGR)`,
			);
		}
	}
}

// ── Main ──

const investments = discoverInvestments();

if (investments.length === 0) {
	console.log("No investment accounts found (Assets:Investments:*).");
	process.exit(0);
}

const currency = detectCurrency();
console.log("Investment Returns Report");
console.log("As of latest available prices");

let totalDeposited = 0;
let totalMarketValue = 0;
let totalCash = 0;
let totalFees = 0;

for (const inv of investments) {
	const data = getInvestmentData(inv);
	printInvestment(data);
	totalDeposited += data.totalDeposited;
	totalMarketValue += data.marketValue;
	totalCash += data.cashBalance;
	totalFees += data.fees;
}

if (investments.length > 1) {
	const combinedCurrent = totalMarketValue + totalCash;
	const combinedReturn = combinedCurrent - totalDeposited;
	const combinedPct =
		totalDeposited > 0 ? (combinedReturn / totalDeposited) * 100 : 0;

	console.log(`\n${"═".repeat(55)}`);
	console.log("  Combined");
	console.log(`${"═".repeat(55)}`);
	console.log(
		`  Deposited:        ${fmtAmt(totalDeposited, currency).padStart(15)}`,
	);
	console.log(
		`  Total fees:       ${fmtAmt(totalFees, currency).padStart(15)}`,
	);
	console.log(
		`  Current value:    ${fmtAmt(combinedCurrent, currency).padStart(15)}`,
	);
	console.log(
		`  Total return:     ${fmtAmt(combinedReturn, currency).padStart(15)}  (${fmtPct(combinedPct)} on deposits)`,
	);
}

console.log();
