/**
 * Revolut JSON importer.
 * Transforms Revolut API JSON exports into rummage transactions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BalanceAssertion,
	ImportResult,
	Location,
	Price,
	Transaction,
} from "../../types.ts";
import type { RevolutTransaction } from "./api.ts";

/**
 * Default mapping from Revolut categories to beancount account paths.
 * Used when no custom categoryMapping is provided.
 */
export const DEFAULT_CATEGORY_MAP: Record<string, string> = {
	groceries: "Expenses:Food:Groceries",
	restaurants: "Expenses:Food:Restaurants",
	shopping: "Expenses:Shopping",
	transport: "Expenses:Transport",
	entertainment: "Expenses:Entertainment",
	travel: "Expenses:Transport:Travel",
	health: "Expenses:Health",
	services: "Expenses:Services",
	utilities: "Expenses:Housing:Utilities",
	transfers: "Expenses:Transfers",
	cash: "Expenses:Transfers:Cash",
	general: "Expenses:Uncategorized",
	donation: "Expenses:Giving:Charity",
	salary: "Income:Salary",
	investment: "Expenses:Finance:Investments",
	topup: "Expenses:Transfers:Topup",
	crypto: "Expenses:Finance:Crypto",
	cashback: "Income:Refunds",
	gift: "Expenses:Giving:Gifts",
};

export interface RevolutImportOptions {
	/** Base account path (default: "Assets:Revolut") */
	accountBase?: string;
	/**
	 * Map Revolut categories to beancount account paths.
	 * - omit or undefined: use DEFAULT_CATEGORY_MAP
	 * - Record<string, string>: custom mapping (merged with defaults; use value "" to suppress a key)
	 * - false: disable category mapping entirely (all categories come from rules)
	 */
	categoryMapping?: Record<string, string> | false;
}

/**
 * Convert epoch milliseconds to ISO date string.
 */
function epochToDate(epoch: number): string {
	const date = new Date(epoch);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid epoch timestamp: ${epoch}`);
	}
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Sanitize currency code for beancount compatibility.
 * Beancount currencies must be uppercase letters only (2-24 chars).
 * Revolut uses codes like "X:8:SUI" for some crypto — strip non-alpha chars.
 */
export function sanitizeCurrency(currency: string): string {
	const cleaned = currency.replace(/[^A-Za-z]/g, "").toUpperCase();
	if (cleaned.length === 0) {
		throw new Error(`Currency "${currency}" has no valid characters`);
	}
	return cleaned;
}

/** Decimal places for different currencies (fiat = 2, crypto varies) */
const CURRENCY_DECIMALS: Record<string, number> = {
	BTC: 8,
	ETH: 8,
	LTC: 8,
	XRP: 6,
	BCH: 8,
	DOGE: 8,
	DOT: 2,
	"X:8:SUI": 2,
};

/**
 * Convert Revolut amount (in minor units) to decimal.
 * Fiat uses 2 decimals (cents), crypto uses more (e.g., BTC = 8 for satoshis).
 */
function amountToDecimal(amount: number, currency: string): number {
	const decimals = CURRENCY_DECIMALS[currency] ?? 2;
	return amount / 10 ** decimals;
}

/**
 * Build a location from merchant data if available.
 */
function buildLocation(
	merchant: RevolutTransaction["merchant"],
): Location | undefined {
	if (!merchant?.city && !merchant?.address) {
		return undefined;
	}
	const parts = [merchant.city, merchant.country].filter(Boolean);
	return {
		name: parts.join(", "),
	};
}

/**
 * Map Revolut category to a beancount account path.
 * Uses the provided mapping, or undefined if mapping is false (disabled).
 */
function mapCategory(
	category: string | undefined,
	mapping: Record<string, string> | false,
): string | undefined {
	if (!category || mapping === false) return undefined;
	return mapping[category.toLowerCase()];
}

/**
 * Resolve the categoryMapping option into the mapping to use.
 * - undefined → DEFAULT_CATEGORY_MAP
 * - false → false (disabled)
 * - Record → merged with defaults (custom values override; empty string suppresses a key)
 */
function resolveCategoryMapping(
	option: RevolutImportOptions["categoryMapping"],
): Record<string, string> | false {
	if (option === false) return false;
	if (option === undefined) return DEFAULT_CATEGORY_MAP;
	const merged = { ...DEFAULT_CATEGORY_MAP, ...option };
	// Remove keys with empty string values (allows suppressing defaults)
	for (const [key, value] of Object.entries(merged)) {
		if (value === "") delete merged[key];
	}
	return merged;
}

/**
 * Check if this is the receiving leg of an exchange (should be skipped).
 * For exchanges, we only process the outgoing (negative) leg.
 */
function isExchangeReceivingLeg(txn: RevolutTransaction): boolean {
	return txn.type === "EXCHANGE" && txn.amount > 0;
}

/**
 * Check if a transaction is on a savings/vault account.
 * Used to filter balance calculations — SAVINGS account balances
 * reflect the vault balance, not the current account balance.
 * Note: vault transfers (identifiable by `vault` field) have both a CURRENT
 * and SAVINGS leg that net to zero in transactions, but SAVINGS balances
 * must be excluded from balance assertions.
 */
function isSavingsTransaction(txn: RevolutTransaction): boolean {
	return txn.account?.type === "SAVINGS";
}

/**
 * Check if a transaction is completed (not cancelled, declined, etc.).
 */
function isCompletedTransaction(txn: RevolutTransaction): boolean {
	return (
		txn.state !== "CANCELLED" &&
		txn.state !== "DECLINED" &&
		txn.state !== "REVERTED" &&
		txn.state !== "FAILED"
	);
}

/**
 * Extract balance assertion from the latest completed transaction with balance data.
 * Returns the balance after the most recent transaction for the account.
 * Includes ALL transactions (even exchange receiving legs) because the bank's
 * reported balance reflects all activity. The exchange is still processed via
 * the transfer from the outgoing leg.
 */
function extractBalanceAssertion(
	transactions: RevolutTransaction[],
	accountBase: string,
	source: string,
): BalanceAssertion | undefined {
	// Filter to completed transactions with balance data
	// Include exchange receiving legs - they have the correct final balance
	const withBalance = transactions.filter(
		(t) =>
			isCompletedTransaction(t) &&
			!isSavingsTransaction(t) &&
			t.balance !== undefined,
	);

	if (withBalance.length === 0) return undefined;

	// Find the latest transaction by startedDate
	const latest = withBalance.reduce((a, b) =>
		a.startedDate > b.startedDate ? a : b,
	);

	if (latest.balance === undefined) return undefined;

	const rawCurrency = latest.currency;
	const currency = sanitizeCurrency(rawCurrency);
	const balance = amountToDecimal(latest.balance, rawCurrency);

	// Balance assertion date is the day AFTER the latest transaction
	// because beancount checks balance at the START of the day
	const nextDay = new Date(latest.startedDate);
	nextDay.setDate(nextDay.getDate() + 1);

	return {
		date: epochToDate(nextDay.getTime()),
		account: `${accountBase}:${currency}`,
		balance: { value: balance, currency },
		source,
	};
}

/**
 * Extract opening balance from the oldest completed transaction with balance data.
 * Calculates: opening_balance = oldest.balance - oldest.amount
 * This gives us the balance before the oldest transaction was applied.
 */
function extractOpeningBalance(
	transactions: RevolutTransaction[],
	accountBase: string,
	source: string,
): BalanceAssertion | undefined {
	// Filter to completed current-account transactions with balance data
	const withBalance = transactions.filter(
		(t) =>
			isCompletedTransaction(t) &&
			!isSavingsTransaction(t) &&
			t.balance !== undefined,
	);

	if (withBalance.length === 0) return undefined;

	// Find the oldest transaction by startedDate
	const oldest = withBalance.reduce((a, b) =>
		a.startedDate < b.startedDate ? a : b,
	);

	if (oldest.balance === undefined) return undefined;

	const rawCurrency = oldest.currency;
	const currency = sanitizeCurrency(rawCurrency);
	// Opening balance = post-transaction balance - transaction amount
	// This "undoes" the transaction to get what was there before
	const openingBalance = amountToDecimal(
		oldest.balance - oldest.amount,
		rawCurrency,
	);

	return {
		// Date is the day before the oldest transaction
		date: epochToDate(oldest.startedDate),
		account: `${accountBase}:${currency}`,
		balance: { value: openingBalance, currency },
		source,
	};
}

/**
 * Extract price directive from an exchange transaction.
 * Only processes the outgoing (selling) leg to avoid duplicates.
 */
function extractPriceFromExchange(
	txn: RevolutTransaction,
	source: string,
): Price | undefined {
	// Only process EXCHANGE transactions with rate and counterpart
	if (txn.type !== "EXCHANGE" || !txn.rate || !txn.counterpart) {
		return undefined;
	}

	// Only process outgoing leg (amount < 0 = selling)
	if (txn.amount > 0) return undefined;

	// From EUR_2025.json: selling EUR, rate=25.0, counterpart=CZK
	// This means: 1 EUR = 25 CZK (rate is how much quote currency per 1 base)
	const baseCurrency = sanitizeCurrency(txn.currency); // EUR (being sold)
	const quoteCurrency = sanitizeCurrency(txn.counterpart.currency); // CZK (being bought)

	return {
		date: epochToDate(txn.startedDate),
		baseCurrency,
		quoteCurrency,
		price: txn.rate,
		source,
	};
}

/**
 * Import a single Revolut transaction.
 */
function importTransaction(
	txn: RevolutTransaction,
	accountBase: string,
	source: string,
	categoryMapping: Record<string, string> | false,
): Transaction {
	const description = txn.merchant?.name ?? txn.description ?? "Unknown";
	const currency = sanitizeCurrency(txn.currency);
	// Use transaction's actual currency for account name
	const accountName = `${accountBase}:${currency}`;

	const result: Transaction = {
		id: `revolut-${txn.legId}`,
		date: epochToDate(txn.startedDate),
		amount: {
			value: amountToDecimal(txn.amount, txn.currency),
			currency,
		},
		description,
		account: accountName,
		source,
		category: mapCategory(txn.category, categoryMapping),
	};

	// Handle exchange transactions - set up transfer to destination account
	if (txn.type === "EXCHANGE" && txn.counterpart) {
		const destCurrency = sanitizeCurrency(txn.counterpart.currency);
		result.transfer = {
			toAccount: `${accountBase}:${destCurrency}`,
			toAmount: {
				value: amountToDecimal(
					txn.counterpart.amount,
					txn.counterpart.currency,
				),
				currency: destCurrency,
			},
		};
		// Clear category - exchanges are transfers, not expenses
		result.category = undefined;
	} else if (txn.counterpart) {
		// Add original amount if there was currency conversion (non-exchange)
		result.originalAmount = {
			value: amountToDecimal(txn.counterpart.amount, txn.counterpart.currency),
			currency: sanitizeCurrency(txn.counterpart.currency),
		};
	}

	// Add location from merchant data
	const location = buildLocation(txn.merchant);
	if (location) {
		result.location = location;
	}

	// Add tags from Revolut category/tag
	const tags: string[] = [];
	if (txn.tag && txn.tag !== txn.category) {
		tags.push(txn.tag);
	}
	if (txn.type === "TOPUP") {
		tags.push("topup");
	}
	if (txn.type === "TRANSFER") {
		tags.push("transfer");
	}
	if (tags.length > 0) {
		result.tags = tags;
	}

	// Store rich metadata
	result.metadata = {
		revolutType: txn.type,
		revolutState: txn.state,
		revolutCategory: txn.category,
		merchant: txn.merchant
			? {
					name: txn.merchant.name,
					mcc: txn.merchant.mcc,
					category: txn.merchant.category,
					city: txn.merchant.city,
					country: txn.merchant.country,
					address: txn.merchant.address,
				}
			: undefined,
		rate: txn.rate,
		fee: txn.fee ? amountToDecimal(txn.fee, txn.currency) : undefined,
		countryCode: txn.countryCode,
		comment: txn.comment,
	};

	return result;
}

/**
 * Import transactions from a Revolut JSON file.
 */
export function importRevolutFile(
	filePath: string,
	options: RevolutImportOptions = {},
): ImportResult {
	const content = readFileSync(filePath, "utf-8");
	const data = JSON.parse(content) as RevolutTransaction[];

	const accountBase = options.accountBase ?? "Assets:Revolut";
	const categoryMapping = resolveCategoryMapping(options.categoryMapping);

	const transactions: Transaction[] = [];
	const errors: ImportResult["errors"] = [];

	for (const txn of data) {
		try {
			// Skip cancelled/declined/reverted transactions
			if (
				txn.state === "CANCELLED" ||
				txn.state === "DECLINED" ||
				txn.state === "REVERTED" ||
				txn.state === "FAILED"
			) {
				continue;
			}

			// Skip receiving leg of exchange transactions (we handle the sending leg only)
			if (isExchangeReceivingLeg(txn)) {
				continue;
			}

			const transaction = importTransaction(
				txn,
				accountBase,
				filePath,
				categoryMapping,
			);

			// Mark pending transactions
			if (txn.state === "PENDING") {
				transaction.pending = true;
			}

			transactions.push(transaction);
		} catch (e) {
			errors.push({
				source: filePath,
				message: `Failed to import transaction ${txn.id}: ${e instanceof Error ? e.message : String(e)}`,
				raw: JSON.stringify(txn),
			});
		}
	}

	// Sort by date
	transactions.sort((a, b) => a.date.localeCompare(b.date));

	// Extract balance assertion from latest completed transaction
	const balanceAssertion = extractBalanceAssertion(data, accountBase, filePath);

	// Extract opening balance from oldest completed transaction
	const openingBalance = extractOpeningBalance(data, accountBase, filePath);

	// Extract prices from exchange transactions
	const prices: Price[] = [];
	for (const txn of data) {
		if (isCompletedTransaction(txn)) {
			const price = extractPriceFromExchange(txn, filePath);
			if (price) prices.push(price);
		}
	}

	return {
		transactions,
		errors,
		balanceAssertions: balanceAssertion ? [balanceAssertion] : undefined,
		openingBalances: openingBalance ? [openingBalance] : undefined,
		prices: prices.length > 0 ? prices : undefined,
	};
}

/**
 * Calculate opening balances and balance assertions at the directory level.
 * This considers ALL transactions from all files, including exchange receiving legs
 * that might be in different currency files than expected.
 *
 * For example: EUR_2018.json may contain CZK exchange receiving legs, which are
 * the first CZK transactions chronologically, even though CZK_2018.json exists.
 */
function calculateDirectoryBalances(
	allRawTransactions: RevolutTransaction[],
	accountBase: string,
	source: string,
): {
	openingBalances: BalanceAssertion[];
	balanceAssertions: BalanceAssertion[];
} {
	// Group all transactions by currency
	const byCurrency = new Map<string, RevolutTransaction[]>();
	for (const txn of allRawTransactions) {
		if (
			!isCompletedTransaction(txn) ||
			isSavingsTransaction(txn) ||
			txn.balance === undefined
		)
			continue;
		const key = sanitizeCurrency(txn.currency);
		const existing = byCurrency.get(key) ?? [];
		existing.push(txn);
		byCurrency.set(key, existing);
	}

	const openingBalances: BalanceAssertion[] = [];
	const balanceAssertions: BalanceAssertion[] = [];

	for (const [currency, txns] of byCurrency) {
		// Find oldest transaction for opening balance
		const oldest = txns.reduce((a, b) =>
			a.startedDate < b.startedDate ? a : b,
		);
		if (oldest.balance === undefined) continue;
		const openingBalance = amountToDecimal(
			oldest.balance - oldest.amount,
			oldest.currency,
		);
		openingBalances.push({
			date: epochToDate(oldest.startedDate),
			account: `${accountBase}:${currency}`,
			balance: { value: openingBalance, currency },
			source,
		});

		// Find latest transaction for balance assertion
		const latest = txns.reduce((a, b) =>
			a.startedDate > b.startedDate ? a : b,
		);
		if (latest.balance === undefined) continue;
		const balance = amountToDecimal(latest.balance, latest.currency);
		const nextDay = new Date(latest.startedDate);
		nextDay.setDate(nextDay.getDate() + 1);
		balanceAssertions.push({
			date: epochToDate(nextDay.getTime()),
			account: `${accountBase}:${currency}`,
			balance: { value: balance, currency },
			source,
		});
	}

	return { openingBalances, balanceAssertions };
}

/**
 * Import all Revolut JSON files from a directory.
 * Deduplicates by transaction ID since exchange transactions appear in multiple currency files.
 * Calculates opening balances and balance assertions at the directory level to properly
 * handle currencies that first appear via exchanges in other currency files.
 */
export function importRevolutDirectory(
	dirPath: string,
	options: RevolutImportOptions = {},
): ImportResult {
	const files = readdirSync(dirPath) as string[];
	const jsonFiles = files.filter(
		(f: string) => /^[A-Z]{3}_\d{4}\.json$/.test(f), // Match USD_2024.json pattern
	);

	const accountBase = options.accountBase ?? "Assets:Revolut";
	const categoryMapping = resolveCategoryMapping(options.categoryMapping);

	// First pass: collect all raw transactions from all files
	const allRawTransactions: RevolutTransaction[] = [];
	for (const file of jsonFiles) {
		const content = readFileSync(join(dirPath, file), "utf-8");
		const data = JSON.parse(content) as RevolutTransaction[];
		allRawTransactions.push(...data);
	}

	// Calculate opening balances and balance assertions at directory level
	// This considers ALL transactions including exchange receiving legs
	const { openingBalances, balanceAssertions } = calculateDirectoryBalances(
		allRawTransactions,
		accountBase,
		dirPath,
	);

	// Second pass: import transactions (with deduplication)
	const seenIds = new Set<string>();
	const allTransactions: Transaction[] = [];
	const allErrors: ImportResult["errors"] = [];
	const allPrices: Price[] = [];

	for (const file of jsonFiles) {
		const filePath = join(dirPath, file);
		const content = readFileSync(filePath, "utf-8");
		const data = JSON.parse(content) as RevolutTransaction[];

		for (const txn of data) {
			// Skip cancelled/declined/reverted transactions
			if (!isCompletedTransaction(txn) && txn.state !== "PENDING") continue;

			// Skip receiving leg of exchange transactions (we handle the sending leg only)
			if (isExchangeReceivingLeg(txn)) continue;

			const id = `revolut-${txn.legId}`;
			if (seenIds.has(id)) continue;
			seenIds.add(id);

			try {
				const transaction = importTransaction(
					txn,
					accountBase,
					filePath,
					categoryMapping,
				);
				if (txn.state === "PENDING") {
					transaction.pending = true;
				}
				allTransactions.push(transaction);
			} catch (e) {
				allErrors.push({
					source: filePath,
					message: `Failed to import transaction ${txn.id}: ${e instanceof Error ? e.message : String(e)}`,
					raw: JSON.stringify(txn),
				});
			}

			// Extract prices from exchange transactions
			if (isCompletedTransaction(txn)) {
				const price = extractPriceFromExchange(txn, filePath);
				if (price) allPrices.push(price);
			}
		}
	}

	// Sort by date
	allTransactions.sort((a, b) => a.date.localeCompare(b.date));

	return {
		transactions: allTransactions,
		errors: allErrors,
		balanceAssertions:
			balanceAssertions.length > 0 ? balanceAssertions : undefined,
		openingBalances: openingBalances.length > 0 ? openingBalances : undefined,
		prices: allPrices.length > 0 ? allPrices : undefined,
	};
}
