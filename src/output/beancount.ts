/**
 * Beancount output generator.
 * Produces valid beancount files from transactions.
 */

import { writeFileSync } from "node:fs";
import type {
	Account,
	BalanceAssertion,
	CommodityDefinition,
	Price,
	Transaction,
} from "../types.ts";

/**
 * Format a number for beancount (2 decimal places).
 */
function formatAmount(value: number, decimals = 2): string {
	return value.toFixed(decimals);
}

/**
 * Convert a key to valid beancount metadata key format.
 * Keys must be lowercase, can contain letters, numbers, dashes, underscores.
 */
function toMetadataKey(key: string): string {
	return key
		.replace(/([A-Z])/g, "-$1") // camelCase to kebab-case
		.toLowerCase()
		.replace(/[^a-z0-9-_]/g, "-") // replace invalid chars
		.replace(/^-/, ""); // remove leading dash
}

/**
 * Format a metadata value for beancount.
 * Strings get quoted, numbers and booleans don't.
 */
function formatMetadataValue(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		if (value === "") return null;
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (typeof value === "boolean") {
		return value ? "TRUE" : "FALSE";
	}
	// Skip complex objects
	return null;
}

/**
 * Collect all unique accounts from transactions.
 * Returns account names for both asset accounts and category accounts.
 */
function collectAccountsFromTransactions(
	transactions: Transaction[],
): Set<string> {
	const accounts = new Set<string>();

	for (const txn of transactions) {
		accounts.add(txn.account);
		if (txn.commodity) {
			accounts.add(txn.commodity.account);
		} else if (txn.transfer) {
			accounts.add(txn.transfer.toAccount);
		} else {
			accounts.add(txn.category ?? "Expenses:Uncategorized");
		}
	}

	return accounts;
}

/**
 * Find the earliest transaction date for opening accounts.
 */
function findEarliestDate(
	transactions: Transaction[],
	openingBalances?: BalanceAssertion[],
): string {
	if (
		transactions.length === 0 &&
		(!openingBalances || openingBalances.length === 0)
	)
		return "2020-01-01";

	let earliest = transactions[0]?.date ?? "9999-12-31";
	for (const txn of transactions) {
		if (txn.date < earliest) {
			earliest = txn.date;
		}
	}

	// Also consider opening balance dates
	if (openingBalances) {
		for (const ob of openingBalances) {
			if (ob.date < earliest) {
				earliest = ob.date;
			}
		}
	}

	// Open accounts one day before first transaction/opening balance
	const date = new Date(earliest);
	date.setDate(date.getDate() - 1);
	return date.toISOString().slice(0, 10);
}

/**
 * Generate account open directives.
 * Merges explicitly defined accounts with accounts discovered in transactions.
 */
function generateAccountDirectives(
	accounts: Account[],
	transactions: Transaction[],
	openingBalances?: BalanceAssertion[],
): string[] {
	const lines: string[] = [];
	const openDate = findEarliestDate(transactions, openingBalances);

	// Build a map of explicitly defined accounts
	const definedAccounts = new Map<string, Account>();
	for (const account of accounts) {
		definedAccounts.set(account.name, account);
	}

	// Collect all accounts used in transactions
	const usedAccounts = collectAccountsFromTransactions(transactions);

	// Merge: use defined account info if available, otherwise use defaults
	const allAccountNames = new Set([...definedAccounts.keys(), ...usedAccounts]);

	const sorted = [...allAccountNames].sort();

	for (const name of sorted) {
		const defined = definedAccounts.get(name);
		const date = defined?.opened ?? openDate;
		const currency = defined?.currency ? ` ${defined.currency}` : "";
		lines.push(`${date} open ${name}${currency}`);
	}

	return lines;
}

/**
 * Generate metadata lines for a transaction.
 */
function generateMetadata(txn: Transaction): string[] {
	const lines: string[] = [];

	// Always include transaction ID for traceability
	lines.push(`  id: "${txn.id}"`);

	// Include source file (just filename, not full path)
	const sourceFile = txn.source.split("/").pop() ?? txn.source;
	lines.push(`  source: "${sourceFile}"`);

	// Include original amount if there was currency conversion
	if (txn.originalAmount) {
		const orig = txn.originalAmount;
		lines.push(
			`  original-amount: "${formatAmount(orig.value)} ${orig.currency}"`,
		);
	}

	// Include bank-specific metadata (flattened)
	if (txn.metadata) {
		for (const [key, value] of Object.entries(txn.metadata)) {
			// Skip nested objects (like merchant) - we'll handle them specially
			if (typeof value === "object" && value !== null) {
				// Flatten merchant object
				if (key === "merchant") {
					const merchant = value as Record<string, unknown>;
					for (const [mKey, mValue] of Object.entries(merchant)) {
						const formatted = formatMetadataValue(mValue);
						if (formatted !== null) {
							lines.push(`  merchant-${toMetadataKey(mKey)}: ${formatted}`);
						}
					}
				}
				continue;
			}

			const formatted = formatMetadataValue(value);
			if (formatted !== null) {
				lines.push(`  ${toMetadataKey(key)}: ${formatted}`);
			}
		}
	}

	return lines;
}

/**
 * Generate a beancount transaction entry.
 */
function generateTransaction(txn: Transaction): string[] {
	const lines: string[] = [];

	// Transaction header
	const payee = txn.payee ? `"${txn.payee}"` : "";
	const narration = `"${txn.description.replace(/"/g, '\\"')}"`;
	const header = payee ? `${payee} ${narration}` : narration;

	// Tags
	const tags = txn.tags?.map((t) => `#${t}`).join(" ") ?? "";
	const tagSuffix = tags ? ` ${tags}` : "";

	// Use ! for pending/uncleared, * for cleared
	const flag = txn.pending ? "!" : "*";
	lines.push(`${txn.date} ${flag} ${header}${tagSuffix}`);

	// Metadata (after header, before postings)
	lines.push(...generateMetadata(txn));

	// Source account posting (the bank account / cash side)
	lines.push(
		`  ${txn.account}  ${formatAmount(txn.amount.value)} ${txn.amount.currency}`,
	);

	if (txn.commodity) {
		// Commodity purchase/sale — counter posting with units at cost
		const { account, units, symbol, costPerUnit } = txn.commodity;
		lines.push(
			`  ${account}  ${units} ${symbol} {${formatAmount(costPerUnit.value, 4)} ${costPerUnit.currency}}`,
		);
	} else if (txn.transfer) {
		// Transfer — destination account with explicit amount and total cost
		const sourceAmount = Math.abs(txn.amount.value);
		lines.push(
			`  ${txn.transfer.toAccount}  ${formatAmount(txn.transfer.toAmount.value)} ${txn.transfer.toAmount.currency} @@ ${formatAmount(sourceAmount)} ${txn.amount.currency}`,
		);
	} else {
		// Normal transaction — counter posting with auto-balance
		const counterAccount = txn.category ?? "Expenses:Uncategorized";
		lines.push(`  ${counterAccount}`);
	}

	return lines;
}

/**
 * Generate a beancount balance assertion directive.
 */
function generateBalanceDirective(assertion: BalanceAssertion): string {
	// Use integer format for whole numbers (commodity units), 2 decimals for currency
	const value = assertion.balance.value;
	const amount = Number.isInteger(value) ? String(value) : formatAmount(value);
	return `${assertion.date} balance ${assertion.account} ${amount} ${assertion.balance.currency}`;
}

/**
 * Generate opening balance transaction lines.
 * Creates a transaction that sets the initial balance for an account.
 */
function generateOpeningBalanceTransaction(
	opening: BalanceAssertion,
): string[] {
	const lines: string[] = [];
	const amount = formatAmount(opening.balance.value);
	const sourceFile = opening.source?.split("/").pop() ?? "manual";

	lines.push(`${opening.date} * "Opening Balance" ^opening`);
	lines.push(`  source: "${sourceFile}"`);
	lines.push(`  ${opening.account}  ${amount} ${opening.balance.currency}`);
	lines.push("  Equity:Opening-Balances");

	return lines;
}

/**
 * Generate a beancount price directive.
 */
function generatePriceDirective(price: Price): string {
	const amount = formatAmount(price.price);
	return `${price.date} price ${price.baseCurrency} ${amount} ${price.quoteCurrency}`;
}

/**
 * Deduplicate prices by (date, baseCurrency, quoteCurrency).
 * Keeps the first occurrence of each unique combination.
 */
function deduplicatePrices(prices: Price[]): Price[] {
	const seen = new Set<string>();
	const result: Price[] = [];

	// Sort by date first
	const sorted = [...prices].sort((a, b) => a.date.localeCompare(b.date));

	for (const price of sorted) {
		const key = `${price.date}:${price.baseCurrency}:${price.quoteCurrency}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(price);
		}
	}

	return result;
}

/**
 * Deduplicate opening balances by account.
 * For each account, keeps the earliest opening balance.
 */
function deduplicateOpeningBalances(
	openingBalances: BalanceAssertion[],
): BalanceAssertion[] {
	const byAccount = new Map<string, BalanceAssertion>();

	for (const opening of openingBalances) {
		const existing = byAccount.get(opening.account);
		// Keep the earliest one for each account
		if (!existing || opening.date < existing.date) {
			byAccount.set(opening.account, opening);
		}
	}

	// Return sorted by date then account
	return [...byAccount.values()].sort((a, b) => {
		const dateCompare = a.date.localeCompare(b.date);
		if (dateCompare !== 0) return dateCompare;
		return a.account.localeCompare(b.account);
	});
}

/**
 * Generate beancount file content.
 */
/**
 * Generate a commodity directive.
 */
function generateCommodityDirective(commodity: CommodityDefinition): string[] {
	const lines: string[] = [];
	lines.push(`${commodity.date} commodity ${commodity.symbol}`);
	if (commodity.name) {
		lines.push(`  name: "${commodity.name}"`);
	}
	if (commodity.isin) {
		lines.push(`  isin: "${commodity.isin}"`);
	}
	return lines;
}

/**
 * Generate beancount file content.
 */
export function generateBeancount(
	transactions: Transaction[],
	accounts: Account[],
	balanceAssertions?: BalanceAssertion[],
	prices?: Price[],
	openingBalances?: BalanceAssertion[],
	includes?: string[],
	commodities?: CommodityDefinition[],
): string {
	const lines: string[] = [];

	// Header
	lines.push("; Generated by rummage 🦝");
	lines.push("; https://github.com/aviraccoon/rummage");
	lines.push("");
	lines.push(`option "operating_currency" "CZK"`);
	lines.push("");

	// Include directives (for supplementary beancount files)
	if (includes && includes.length > 0) {
		for (const inc of includes) {
			lines.push(`include "${inc}"`);
		}
		lines.push("");
	}

	// Commodity definitions
	if (commodities && commodities.length > 0) {
		lines.push("; Commodities");
		for (const commodity of commodities) {
			lines.push(...generateCommodityDirective(commodity));
		}
		lines.push("");
	}

	// Account definitions
	lines.push("; Accounts");
	lines.push(
		...generateAccountDirectives(accounts, transactions, openingBalances),
	);

	// Price directives (after accounts, before transactions)
	if (prices && prices.length > 0) {
		lines.push("");
		lines.push("; Prices");
		const dedupedPrices = deduplicatePrices(prices);
		for (const price of dedupedPrices) {
			lines.push(generatePriceDirective(price));
		}
	}

	// Opening balance transactions (after prices, before regular transactions)
	if (openingBalances && openingBalances.length > 0) {
		lines.push("");
		lines.push("; Opening Balances");
		const dedupedOpenings = deduplicateOpeningBalances(openingBalances);
		for (const opening of dedupedOpenings) {
			lines.push(...generateOpeningBalanceTransaction(opening));
			lines.push("");
		}
	}

	lines.push("");

	// Sort transactions by date
	const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

	// Group by month for readability
	let currentMonth = "";
	for (const txn of sorted) {
		const month = txn.date.slice(0, 7); // YYYY-MM
		if (month !== currentMonth) {
			currentMonth = month;
			lines.push("");
			lines.push(`; === ${month} ===`);
			lines.push("");
		}
		lines.push(...generateTransaction(txn));
		lines.push("");
	}

	// Balance assertions (at the end, after all transactions)
	if (balanceAssertions && balanceAssertions.length > 0) {
		lines.push("");
		lines.push("; Balance Assertions");
		const sortedAssertions = [...balanceAssertions].sort((a, b) =>
			a.date.localeCompare(b.date),
		);
		for (const assertion of sortedAssertions) {
			lines.push(generateBalanceDirective(assertion));
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Write transactions to a beancount file.
 */
export function writeBeancount(
	filePath: string,
	transactions: Transaction[],
	accounts: Account[],
	balanceAssertions?: BalanceAssertion[],
	prices?: Price[],
	openingBalances?: BalanceAssertion[],
	includes?: string[],
	commodities?: CommodityDefinition[],
): void {
	writeFileSync(
		filePath,
		generateBeancount(
			transactions,
			accounts,
			balanceAssertions,
			prices,
			openingBalances,
			includes,
			commodities,
		),
	);
}
