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
import { InflationData } from "../src/lib/inflation.ts";

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

function printInvestment(
	data: InvestmentData,
	cpi?: InflationData | null,
	deposits?: Deposit[],
): void {
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

	// Per-investment inflation-adjusted return
	if (cpi && deposits && deposits.length > 0) {
		const months = cpi.months("all");
		const latestCPI = months[months.length - 1];
		if (latestCPI) {
			let realDeposited = 0;
			for (const dep of deposits) {
				const depYM = dep.date.slice(0, 7);
				const deflated = cpi.deflate(dep.amount, depYM, latestCPI, "all");
				realDeposited += deflated ?? dep.amount;
			}
			const currentValue = data.marketValue + data.cashBalance;
			const realReturn = currentValue - realDeposited;
			const realPct =
				realDeposited > 0 ? (realReturn / realDeposited) * 100 : 0;
			console.log(
				`  Real return:      ${fmtAmt(realReturn, c).padStart(pad)}  (${fmtPct(realPct)} inflation-adjusted)`,
			);
		}
	}
}

// ── Per-deposit data for DCA-aware inflation ──

interface Deposit {
	date: string; // YYYY-MM-DD
	amount: number; // CZK value of this deposit
}

function getDepositHistory(inv: Investment): Deposit[] {
	const deposits: Deposit[] = [];

	// Unit purchases (cost basis per transaction)
	const purchases = beanQuery(
		`SELECT date, cost(position) WHERE account ~ '${inv.assetPattern}' AND account !~ ':Cash$' ORDER BY date`,
	);
	for (const line of purchases.split("\n")) {
		const match = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+([-\d,.]+)\s+\S+/);
		if (match?.[1] && match[2]) {
			const amount = Number.parseFloat(match[2].replace(",", ""));
			if (!Number.isNaN(amount) && amount > 0) {
				deposits.push({ date: match[1], amount });
			}
		}
	}

	// Fees (same dates, separate amounts)
	const fees = beanQuery(
		`SELECT date, position WHERE account = 'Expenses:Finance:Investments:Fees' AND payee = '${inv.feePayee}' ORDER BY date`,
	);
	for (const line of fees.split("\n")) {
		const match = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+([-\d,.]+)\s+\S+/);
		if (match?.[1] && match[2]) {
			const amount = Number.parseFloat(match[2].replace(",", ""));
			if (!Number.isNaN(amount) && amount > 0) {
				deposits.push({ date: match[1], amount });
			}
		}
	}

	// Note: we don't add cash inflows separately. The flow is:
	// bank → Cash → (purchases + fees + rounding).
	// Purchases and fees above already capture the money that entered.
	// Remaining cash balance is small (rounding leftovers).

	return deposits;
}

// ── Currency → country mapping for inflation lookup ──

const CURRENCY_COUNTRY: Record<string, string> = {
	CZK: "CZ",
	EUR: "DE", // use Germany as EUR proxy
	USD: "US",
	GBP: "UK",
	PLN: "PL",
	HUF: "HU",
	SEK: "SE",
	NOK: "NO",
	DKK: "DK",
	CHF: "CH",
};

// ── Main ──

async function main() {
	const investments = discoverInvestments();

	if (investments.length === 0) {
		console.log("No investment accounts found (Assets:Investments:*).");
		process.exit(0);
	}

	const currency = detectCurrency();
	console.log("Investment Returns Report");
	console.log("As of latest available prices");

	// Load inflation data for real return calculation
	const country = CURRENCY_COUNTRY[currency];
	let cpi: InflationData | null = null;
	if (country) {
		try {
			cpi = await InflationData.load(country);
		} catch {
			// offline — skip inflation
		}
	}

	let totalDeposited = 0;
	let totalMarketValue = 0;
	let totalCash = 0;
	let totalFees = 0;
	let earliestDate = "9999-99";
	const allDeposits: Deposit[] = [];

	for (const inv of investments) {
		const data = getInvestmentData(inv);
		const deposits = getDepositHistory(inv);
		allDeposits.push(...deposits);
		printInvestment(data, cpi, deposits);
		totalDeposited += data.totalDeposited;
		totalMarketValue += data.marketValue;
		totalCash += data.cashBalance;
		totalFees += data.fees;
		if (data.firstDate < earliestDate) earliestDate = data.firstDate;
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

	// ── Inflation-adjusted view (DCA-aware) ──

	if (cpi) {
		try {
			const months = cpi.months("all");
			const latestCPI = months[months.length - 1];

			if (latestCPI) {
				if (allDeposits.length > 0) {
					// Deflate each deposit from its own date to today
					let realDeposited = 0;
					let deflatedCount = 0;

					for (const dep of allDeposits) {
						const depYM = dep.date.slice(0, 7); // "2021-02" from "2021-02-25"
						const deflated = cpi.deflate(dep.amount, depYM, latestCPI, "all");
						if (deflated !== undefined) {
							realDeposited += deflated;
							deflatedCount++;
						} else {
							// CPI data missing for this month — use nominal as fallback
							realDeposited += dep.amount;
						}
					}

					const combinedCurrent = totalMarketValue + totalCash;
					const realReturn = combinedCurrent - realDeposited;
					const realPct =
						realDeposited > 0 ? (realReturn / realDeposited) * 100 : 0;
					const overallInflation = cpi.cumulativeInflation(
						earliestDate.slice(0, 7),
						latestCPI,
						"all",
					);

					console.log(`\n${"─".repeat(55)}`);
					console.log(
						`  Inflation-adjusted (${deflatedCount} deposits, CPI through ${latestCPI})`,
					);
					console.log(`${"─".repeat(55)}`);
					console.log(
						`  Deposits in today's ${currency}: ${fmtAmt(realDeposited, currency).padStart(10)}`,
					);
					console.log(
						`  Real return:        ${fmtAmt(realReturn, currency).padStart(15)}  (${fmtPct(realPct)})`,
					);
					if (overallInflation !== undefined) {
						console.log(
							`  CPI ${earliestDate.slice(0, 7)} → ${latestCPI}: ${(overallInflation * 100).toFixed(0)}% (but each deposit adjusted from its own date)`,
						);
					}
					if (realReturn < 0) {
						console.log(
							`  Your money lost purchasing power — inflation ate more than the fund gained.`,
						);
					}
				}
			}
		} catch {
			// Inflation data unavailable — skip section silently
		}
	}

	console.log();
}

main();
