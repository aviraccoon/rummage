/**
 * Subscription / recurring payment detector.
 *
 * Analyzes a beancount file for recurring payment patterns via bean-query.
 * Groups by payee+account, clusters by amount similarity to separate
 * mixed subscriptions (e.g. multiple tiers through same payee).
 *
 * Usage:
 *   bun scripts/subscriptions.ts [options] [beancount-file]
 *   bun scripts/subscriptions.ts --sort next
 *   bun scripts/subscriptions.ts --all
 *
 * Default: reads from $RUMMAGE_DATA_SOURCE/generated/main.beancount
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DATA_PATH } from "../src/config.ts";

// ── CLI ──

const SORT_OPTIONS = ["cost", "next", "payee", "cadence"] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

const { values: flags, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		all: { type: "boolean", default: false },
		sort: { type: "string", default: "cost" },
		currency: { type: "string", short: "c" },
		help: { type: "boolean", short: "h", default: false },
	},
	allowPositionals: true,
	strict: true,
});

if (flags.help) {
	console.log(`Usage: bun scripts/subscriptions.ts [options] [beancount-file]

Detects recurring payments in beancount data.

Options:
  --all               Show all cancelled subscriptions (default: last 2 years)
  --sort <field>      Sort active list by: cost (default), next, payee, cadence
  -c, --currency <X>  Currency for totals (default: auto-detect most common)
  -h, --help          Show this help

Default file: $RUMMAGE_DATA_SOURCE/generated/main.beancount`);
	process.exit(0);
}

const sortBy = (flags.sort ?? "cost") as SortOption;
if (!SORT_OPTIONS.includes(sortBy)) {
	console.error(`Invalid --sort value: ${flags.sort}`);
	console.error(`Valid options: ${SORT_OPTIONS.join(", ")}`);
	process.exit(1);
}

const showAll = flags.all;
const CANCELLED_MAX_AGE_DAYS = 730;

const filePath =
	positionals[0] || join(DATA_PATH, "generated", "main.beancount");

// ── Types ──

interface Posting {
	date: string;
	payee: string;
	account: string;
	amount: number;
	currency: string;
}

type Cadence = "monthly" | "quarterly" | "yearly" | "irregular";

interface Subscription {
	payee: string;
	account: string;
	/** Short account label (last 1-2 segments) */
	accountLabel: string;
	cadence: Cadence;
	medianIntervalDays: number;
	avgAmount: number;
	currency: string;
	lastAmount: number;
	lastDate: string;
	firstDate: string;
	count: number;
	monthlyCost: number;
	/** Annual cost in original currency */
	annualCost: number;
	/** Lifetime total spent in original currency */
	lifetimeTotal: number;
	/** Lifetime total in CZK */
	lifetimeBase: number;
	active: boolean;
	daysSinceLast: number;
	amountCV: number;
	nextDate: string | null;
}

// ── Bean-query ──

function beanQuery(bql: string): string[][] {
	const escaped = bql.replace(/"/g, '\\"');
	const cmd = `bean-query "${filePath}" "${escaped}"`;
	const raw = execSync(cmd, { encoding: "utf-8" });
	const lines = raw.trim().split("\n");
	if (lines.length < 3) return [];
	return lines.slice(2).map((line) =>
		line
			.split(/\s{2,}/)
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

function fetchPostings(): Posting[] {
	const rows = beanQuery(
		"SELECT date, payee, account, number, currency WHERE account ~ '^Expenses:' AND payee != '' ORDER BY date",
	);
	return rows
		.map((cols) => {
			const date = cols[0];
			const payee = cols[1];
			const account = cols[2];
			const numStr = cols[3];
			const currency = cols[4];
			if (!date || !payee || !account || !numStr || !currency) return null;
			const amount = Number.parseFloat(numStr.replace(",", ""));
			if (Number.isNaN(amount)) return null;
			return { date, payee, account, amount, currency };
		})
		.filter((p): p is Posting => p !== null);
}

/**
 * Detect the most common currency across postings.
 * This becomes the default base currency for totals.
 */
function detectBaseCurrency(postings: Posting[]): string {
	const counts = new Map<string, number>();
	for (const p of postings) {
		counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
	}
	let best = "USD";
	let bestCount = 0;
	for (const [currency, count] of counts) {
		if (count > bestCount) {
			best = currency;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Parse exchange rates from beancount price directives.
 * Rates map: currency → how many baseCurrency units per 1 of that currency.
 * Uses direct "price X N BASE" and inverse "price BASE N X" directives.
 */
function fetchExchangeRates(baseCurrency: string): Map<string, number> {
	const rates = new Map<string, number>();
	rates.set(baseCurrency, 1);

	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return rates;
	}

	// Direct: "price FOREIGN N BASE" → 1 FOREIGN = N BASE
	const direct = new RegExp(
		String.raw`^\d{4}-\d{2}-\d{2}\s+price\s+(\S+)\s+([\d.]+)\s+${baseCurrency}$`,
		"gm",
	);
	for (const match of content.matchAll(direct)) {
		const currency = match[1];
		const rate = Number.parseFloat(match[2] ?? "");
		if (currency && !Number.isNaN(rate) && rate > 0) {
			rates.set(currency, rate);
		}
	}

	// Inverse: "price BASE N FOREIGN" → 1 FOREIGN = 1/N BASE
	const inverse = new RegExp(
		String.raw`^\d{4}-\d{2}-\d{2}\s+price\s+${baseCurrency}\s+([\d.]+)\s+(\S+)$`,
		"gm",
	);
	for (const match of content.matchAll(inverse)) {
		const rate = Number.parseFloat(match[1] ?? "");
		const currency = match[2];
		if (currency && !Number.isNaN(rate) && rate > 0 && !rates.has(currency)) {
			rates.set(currency, 1 / rate);
		}
	}

	return rates;
}

// ── Analysis ──

function daysBetween(a: string, b: string): number {
	return Math.abs(
		(new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24),
	);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const atMid = sorted[mid] ?? 0;
	const beforeMid = sorted[mid - 1] ?? 0;
	return sorted.length % 2 ? atMid : (beforeMid + atMid) / 2;
}

function detectCadence(intervalDays: number): Cadence {
	if (intervalDays >= 25 && intervalDays <= 36) return "monthly";
	if (intervalDays >= 80 && intervalDays <= 100) return "quarterly";
	if (intervalDays >= 340 && intervalDays <= 400) return "yearly";
	return "irregular";
}

function monthlyCostForCadence(amount: number, cadence: Cadence): number {
	switch (cadence) {
		case "monthly":
			return Math.abs(amount);
		case "quarterly":
			return Math.abs(amount) / 3;
		case "yearly":
			return Math.abs(amount) / 12;
		case "irregular":
			return Math.abs(amount);
	}
}

function annualCostForCadence(amount: number, cadence: Cadence): number {
	return monthlyCostForCadence(amount, cadence) * 12;
}

function gracePeriodDays(cadence: Cadence): number {
	switch (cadence) {
		case "monthly":
			return 45;
		case "quarterly":
			return 120;
		case "yearly":
			return 395;
		case "irregular":
			return 60;
	}
}

const NON_SUBSCRIPTION_PATTERNS = [
	"food:",
	"restaurants",
	"groceries",
	"nightlife",
	"shopping:",
	"transport:",
	"entertainment:cinema",
	"entertainment:culture",
	"entertainment:nightlife",
	"entertainment:other",
];

const NORMAL_CV_THRESHOLD = 0.5;

function estimateNextDate(lastDate: string, intervalDays: number): string {
	const last = new Date(lastDate);
	last.setDate(last.getDate() + Math.round(intervalDays));
	return last.toISOString().slice(0, 10);
}

function isSubscriptionLikeAccount(account: string): boolean {
	const lower = account.toLowerCase();
	return !NON_SUBSCRIPTION_PATTERNS.some((p) => lower.includes(p));
}

/** Extract a short label from account path: "Expenses:Services:Tools" → "Tools" */
function shortAccountLabel(account: string): string {
	const parts = account.split(":");
	// Skip "Expenses:" prefix, take last 1-2 meaningful segments
	const meaningful = parts.slice(1); // drop "Expenses"
	if (meaningful.length <= 2) return meaningful.join(":");
	return meaningful.slice(-2).join(":");
}

function clusterByAmount(postings: Posting[]): Posting[][] {
	const clusters: Posting[][] = [];

	for (const p of postings) {
		const abs = Math.abs(p.amount);
		let placed = false;

		for (const cluster of clusters) {
			const clusterAmounts = cluster.map((c) => Math.abs(c.amount));
			const clusterMedian = median(clusterAmounts);
			if (clusterMedian === 0) continue;

			const ratio = abs / clusterMedian;
			if (ratio >= 0.7 && ratio <= 1.3) {
				cluster.push(p);
				placed = true;
				break;
			}
		}

		if (!placed) {
			clusters.push([p]);
		}
	}

	return clusters;
}

function analyzeSubscriptions(
	postings: Posting[],
	rates: Map<string, number>,
): Subscription[] {
	const today = new Date().toISOString().slice(0, 10);

	// Group by payee + account
	const groups = new Map<string, Posting[]>();
	for (const p of postings) {
		const key = `${p.payee}\0${p.account}`;
		const group = groups.get(key) ?? [];
		group.push(p);
		groups.set(key, group);
	}

	const subscriptions: Subscription[] = [];

	for (const [key, group] of groups) {
		const [payee, account] = key.split("\0") as [string, string];

		const sorted = [...group].sort(
			(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
		);

		const clusters = clusterByAmount(sorted);

		for (const cluster of clusters) {
			if (cluster.length < 3) continue;

			cluster.sort(
				(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
			);

			const intervals: number[] = [];
			for (let i = 1; i < cluster.length; i++) {
				const prev = cluster[i - 1];
				const curr = cluster[i];
				if (prev && curr) intervals.push(daysBetween(prev.date, curr.date));
			}

			const medianInterval = median(intervals);
			const cadence = detectCadence(medianInterval);

			if (cadence === "irregular") {
				const monthlyCount = intervals.filter((d) => d >= 25 && d <= 36).length;
				if (monthlyCount < intervals.length * 0.5) continue;
			}

			// Primary currency
			const currencyCounts = new Map<string, number>();
			for (const p of cluster) {
				currencyCounts.set(
					p.currency,
					(currencyCounts.get(p.currency) ?? 0) + 1,
				);
			}
			const topCurrency = [...currencyCounts.entries()].sort(
				(a, b) => b[1] - a[1],
			)[0];
			const currency = topCurrency?.[0] ?? "CZK";

			const sameCurrency = cluster.filter((p) => p.currency === currency);
			const amounts = sameCurrency.map((p) => p.amount);
			const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;

			// Use recent charges (last 3) for current cost estimate
			// This avoids historical drag (e.g., rent increasing over years)
			const recentForCost = amounts.slice(-3).map(Math.abs);
			const currentAmount =
				recentForCost.reduce((a, b) => a + b, 0) / recentForCost.length;

			// CV on recent charges (last 6)
			const recentAmounts = amounts.slice(-6).map(Math.abs);
			const recentAvg =
				recentAmounts.reduce((a, b) => a + b, 0) / recentAmounts.length;
			const variance =
				recentAmounts.reduce((sum, a) => sum + (a - recentAvg) ** 2, 0) /
				recentAmounts.length;
			const stdDev = Math.sqrt(variance);
			const cv = recentAvg > 0 ? stdDev / recentAvg : 0;

			if (!isSubscriptionLikeAccount(account)) continue;
			if (cv > NORMAL_CV_THRESHOLD) continue;

			const lastPosting = cluster.at(-1);
			const firstPosting = cluster[0];
			if (!lastPosting || !firstPosting) continue;
			const daysSinceLast = daysBetween(lastPosting.date, today);

			const active =
				daysSinceLast <=
				gracePeriodDays(cadence === "irregular" ? "monthly" : cadence);

			// Lifetime total in original currency
			const lifetimeTotal = amounts.reduce((sum, a) => sum + Math.abs(a), 0);

			// Convert to CZK
			const rate = rates.get(currency) ?? 1;
			const lifetimeBase = lifetimeTotal * rate;

			const monthly = monthlyCostForCadence(currentAmount, cadence);

			subscriptions.push({
				payee,
				account,
				accountLabel: shortAccountLabel(account),
				cadence,
				medianIntervalDays: Math.round(medianInterval),
				avgAmount,
				currency,
				lastAmount: lastPosting.amount,
				lastDate: lastPosting.date,
				firstDate: firstPosting.date,
				count: cluster.length,
				monthlyCost: monthly,
				annualCost: annualCostForCadence(currentAmount, cadence),
				lifetimeTotal,
				lifetimeBase,
				active,
				daysSinceLast: Math.round(daysSinceLast),
				amountCV: Math.round(cv * 100) / 100,
				nextDate: active
					? estimateNextDate(lastPosting.date, medianInterval)
					: null,
			});
		}
	}

	subscriptions.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		switch (sortBy) {
			case "next":
				return (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999");
			case "payee":
				return a.payee.localeCompare(b.payee);
			case "cadence": {
				const order = { monthly: 0, quarterly: 1, yearly: 2, irregular: 3 };
				const diff = order[a.cadence] - order[b.cadence];
				return diff !== 0 ? diff : b.monthlyCost - a.monthlyCost;
			}
			default:
				return b.monthlyCost - a.monthlyCost;
		}
	});

	return subscriptions;
}

// ── Output ──

function fmt(amount: number, currency: string): string {
	const abs = Math.abs(amount);
	return abs >= 100
		? `${abs.toFixed(0)} ${currency}`
		: `${abs.toFixed(2)} ${currency}`;
}

function fmtBase(amount: number, baseCurrency: string): string {
	return `${Math.round(amount).toLocaleString("en-US")} ${baseCurrency}`;
}

function printSubscriptions(
	subscriptions: Subscription[],
	rates: Map<string, number>,
	baseCurrency: string,
) {
	const active = subscriptions.filter((s) => s.active);
	const cancelled = subscriptions.filter((s) => !s.active);
	const today = new Date().toISOString().slice(0, 10);

	// ── Active ──
	console.log(`\n━━ Active Subscriptions (${active.length}) ━━\n`);

	if (active.length === 0) {
		console.log("  None detected.\n");
	} else {
		const padPayee = Math.max(...active.map((s) => s.payee.length), 6);
		const padLabel = Math.max(...active.map((s) => s.accountLabel.length), 8);
		const padCadence = 9;

		console.log(
			`  ${"Payee".padEnd(padPayee)}  ${"Account".padEnd(padLabel)}  ${"Cadence".padEnd(padCadence)}  ${"Amount".padEnd(14)}  ${"Monthly".padEnd(14)}  ${"Annual".padEnd(14)}  ${"Next".padEnd(14)}  ${"Since".padEnd(8)}  Lifetime`,
		);
		console.log(
			`  ${"─".repeat(padPayee)}  ${"─".repeat(padLabel)}  ${"─".repeat(padCadence)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(8)}  ${"─".repeat(14)}`,
		);

		let totalMonthlyBase = 0;
		let totalAnnualBase = 0;
		let totalLifetimeBase = 0;

		for (const sub of active) {
			const rate = rates.get(sub.currency) ?? 1;
			const monthlyBase = sub.monthlyCost * rate;
			const annualBase = sub.annualCost * rate;
			totalMonthlyBase += monthlyBase;
			totalAnnualBase += annualBase;
			totalLifetimeBase += sub.lifetimeBase;

			const overdue = sub.nextDate && sub.nextDate < today ? " ⚠" : "";
			const next = `${sub.nextDate ?? "—"}${overdue}`;
			const since = `${sub.firstDate.slice(0, 7)}`;

			console.log(
				`  ${sub.payee.padEnd(padPayee)}  ${sub.accountLabel.padEnd(padLabel)}  ${sub.cadence.padEnd(padCadence)}  ${fmt(sub.lastAmount, sub.currency).padEnd(14)}  ${fmtBase(monthlyBase, baseCurrency).padEnd(14)}  ${fmtBase(annualBase, baseCurrency).padEnd(14)}  ${next.padEnd(14)}  ${since.padEnd(8)}  ${fmtBase(sub.lifetimeBase, baseCurrency)}`,
			);
		}

		console.log();
		console.log(`  Totals:`);
		console.log(`    Monthly:  ${fmtBase(totalMonthlyBase, baseCurrency)}`);
		console.log(`    Annual:   ${fmtBase(totalAnnualBase, baseCurrency)}`);
		console.log(`    Lifetime: ${fmtBase(totalLifetimeBase, baseCurrency)}`);

		// ── Account breakdown ──
		const byAccount = new Map<
			string,
			{ monthlyBase: number; annualBase: number; items: string[] }
		>();
		for (const sub of active) {
			const rate = rates.get(sub.currency) ?? 1;
			const label = sub.accountLabel;
			const existing = byAccount.get(label) ?? {
				monthlyBase: 0,
				annualBase: 0,
				items: [],
			};
			existing.monthlyBase += sub.monthlyCost * rate;
			existing.annualBase += sub.annualCost * rate;
			existing.items.push(sub.payee);
			byAccount.set(label, existing);
		}

		console.log(`\n  By category:`);
		const sortedAccounts = [...byAccount.entries()].sort(
			(a, b) => b[1].annualBase - a[1].annualBase,
		);
		for (const [label, data] of sortedAccounts) {
			console.log(
				`    ${label.padEnd(20)}  ${fmtBase(data.monthlyBase, baseCurrency).padEnd(14)}/mo  ${fmtBase(data.annualBase, baseCurrency).padEnd(14)}/yr  (${data.items.join(", ")})`,
			);
		}
	}

	// ── Cancelled ──
	const shownCancelled = showAll
		? cancelled
		: cancelled.filter((s) => s.daysSinceLast <= CANCELLED_MAX_AGE_DAYS);
	const omitted = cancelled.length - shownCancelled.length;

	if (shownCancelled.length > 0) {
		const suffix = omitted > 0 ? ` — ${omitted} older omitted, use --all` : "";
		console.log(
			`\n━━ Cancelled / Inactive (${shownCancelled.length})${suffix} ━━\n`,
		);

		const padPayee = Math.max(...shownCancelled.map((s) => s.payee.length), 6);
		const padLabel = Math.max(
			...shownCancelled.map((s) => s.accountLabel.length),
			8,
		);

		console.log(
			`  ${"Payee".padEnd(padPayee)}  ${"Account".padEnd(padLabel)}  ${"Cadence".padEnd(9)}  ${"Was Paying".padEnd(14)}  ${"Was/mo".padEnd(14)}  ${"Last Date".padEnd(12)}  Lifetime`,
		);
		console.log(
			`  ${"─".repeat(padPayee)}  ${"─".repeat(padLabel)}  ${"─".repeat(9)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(12)}  ${"─".repeat(14)}`,
		);

		for (const sub of shownCancelled) {
			const rate = rates.get(sub.currency) ?? 1;
			const wasMonthlyBase = sub.monthlyCost * rate;
			console.log(
				`  ${sub.payee.padEnd(padPayee)}  ${sub.accountLabel.padEnd(padLabel)}  ${sub.cadence.padEnd(9)}  ${fmt(sub.avgAmount, sub.currency).padEnd(14)}  ${fmtBase(wasMonthlyBase, baseCurrency).padEnd(14)}  ${sub.lastDate.padEnd(12)}  ${fmtBase(sub.lifetimeBase, baseCurrency)}`,
			);
		}
	}

	console.log();
}

// ── Main ──

function main() {
	const postings = fetchPostings();
	if (postings.length === 0) {
		console.error(`No postings found. Check file: ${filePath}`);
		process.exit(1);
	}

	const baseCurrency = flags.currency ?? detectBaseCurrency(postings);
	const rates = fetchExchangeRates(baseCurrency);
	const subscriptions = analyzeSubscriptions(postings, rates);
	if (subscriptions.length === 0) {
		console.log("No recurring payment patterns detected.");
		return;
	}

	printSubscriptions(subscriptions, rates, baseCurrency);
}

main();
