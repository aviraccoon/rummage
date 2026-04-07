/**
 * Conseq investment fund importer.
 *
 * Reads Conseq portal exports:
 *   - *_SHARES.xlsx — unit purchases with trade/settlement dates, counts, prices
 *   - *_CASH.xlsx — cash movements (deposits, fees, purchases, rounding)
 *   - *_account.xlsx — current holdings snapshot (for balance assertions)
 *
 * Produces Transaction objects with commodity postings for share purchases,
 * plus price directives, commodity definitions, and balance assertions.
 *
 * The bank-side transactions (deposits into the cash account) are handled by
 * the main pipeline via categorization rules. This importer generates the
 * Conseq-internal movements: entry fee, share purchases, and rounding adjustments.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import XLSX from "xlsx";
import type {
	BalanceAssertion,
	CommodityDefinition,
	ImportError,
	ImportResult,
	Price,
	Transaction,
} from "../../types.ts";

export interface ConseqConfig {
	/** Commodity symbol for beancount (default: derived from fund name) */
	commoditySymbol?: string;
	/** Account for fund units (default: Assets:Investments:Conseq) */
	fundAccount?: string;
	/** Account for cash held at Conseq (default: Assets:Investments:Conseq:Cash) */
	cashAccount?: string;
	/** Account for entry fees (default: Expenses:Finance:Investments:Fees) */
	feeAccount?: string;
	/** Account for rounding adjustments (default: Income:Investments:Conseq:Rounding) */
	roundingAccount?: string;
}

interface SharePurchase {
	tradeDate: string;
	settlementDate: string;
	fundName: string;
	isin: string;
	units: number;
	pricePerUnit: number;
	totalCZK: number;
}

interface CashEntry {
	date: string;
	description: string;
	type: "Kredit" | "Debet";
	amount: number;
}

interface AccountSnapshot {
	units: number;
	pricePerUnit: number;
	marketValue: number;
	cashBalance: number;
}

/**
 * Convert Excel serial date to YYYY-MM-DD string.
 */
function excelDateToString(serial: number): string {
	const utcDays = serial - 25569;
	const date = new Date(utcDays * 86400000);
	return date.toISOString().slice(0, 10);
}

/**
 * Read the first sheet from an xlsx file, returning rows as arrays.
 */
function readSheet(filePath: string): unknown[][] {
	const wb = XLSX.readFile(filePath);
	const sheetName = wb.SheetNames[0];
	if (!sheetName) throw new Error(`No sheets in ${filePath}`);
	const ws = wb.Sheets[sheetName];
	if (!ws) throw new Error(`Sheet not found in ${filePath}`);
	return XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
}

function parseShares(filePath: string): SharePurchase[] {
	const rows = readSheet(filePath);
	const purchases: SharePurchase[] = [];

	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		if (!row?.[0]) continue;

		purchases.push({
			tradeDate: excelDateToString(row[0] as number),
			settlementDate: excelDateToString(row[1] as number),
			fundName: row[2] as string,
			isin: row[3] as string,
			units: row[5] as number,
			pricePerUnit: row[6] as number,
			totalCZK: row[7] as number,
		});
	}

	purchases.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
	return purchases;
}

function parseCash(filePath: string): CashEntry[] {
	const rows = readSheet(filePath);
	const entries: CashEntry[] = [];

	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		if (!row?.[0]) continue;

		entries.push({
			date: excelDateToString(row[0] as number),
			description: row[1] as string,
			type: row[4] as "Kredit" | "Debet",
			amount: row[5] as number,
		});
	}

	entries.sort((a, b) => a.date.localeCompare(b.date));
	return entries;
}

function parseAccount(filePath: string): AccountSnapshot {
	const rows = readSheet(filePath);
	const fundRow = rows[1];
	const cashRow = rows[2];
	if (!fundRow || !cashRow) {
		throw new Error("Account snapshot missing expected rows");
	}

	return {
		units: fundRow[2] as number,
		pricePerUnit: fundRow[3] as number,
		marketValue: fundRow[6] as number,
		cashBalance: cashRow[2] as number,
	};
}

/**
 * Find a file matching a suffix in a directory.
 */
function findFile(dirPath: string, suffix: string): string | undefined {
	const files = readdirSync(dirPath);
	const match = files.find((f) => f.endsWith(suffix));
	return match ? join(dirPath, match) : undefined;
}

/**
 * Derive a beancount commodity symbol from a fund name.
 * "Conseq realitní (CZK)" → "CONSEQRE"
 */
function deriveCommoditySymbol(fundName: string): string {
	// Take first word + first 2 chars of second word, uppercase
	const words = fundName
		.replace(/\(.*\)/, "")
		.trim()
		.split(/\s+/);
	const first = (words[0] ?? "").slice(0, 6).toUpperCase();
	const second = (words[1] ?? "").slice(0, 2).toUpperCase();
	return first + second;
}

/**
 * Import Conseq investment data from a directory containing xlsx exports.
 */
export function importConseqDirectory(
	dirPath: string,
	config: ConseqConfig = {},
): ImportResult {
	const errors: ImportError[] = [];
	const transactions: Transaction[] = [];
	const prices: Price[] = [];
	const balanceAssertions: BalanceAssertion[] = [];

	// Find files by suffix pattern
	const sharesFile = findFile(dirPath, "_SHARES.xlsx");
	const cashFile = findFile(dirPath, "_CASH.xlsx");
	const accountFile = findFile(dirPath, "_account.xlsx");

	if (!sharesFile) {
		errors.push({ source: dirPath, message: "No *_SHARES.xlsx file found" });
		return { transactions, errors };
	}
	if (!cashFile) {
		errors.push({ source: dirPath, message: "No *_CASH.xlsx file found" });
		return { transactions, errors };
	}

	const shares = parseShares(sharesFile);
	const cash = parseCash(cashFile);

	// Derive fund details from data
	const firstPurchase = shares[0];
	if (!firstPurchase) {
		errors.push({ source: sharesFile, message: "No purchases found" });
		return { transactions, errors };
	}

	const fundName = firstPurchase.fundName;
	const isin = firstPurchase.isin;
	const commoditySymbol =
		config.commoditySymbol ?? deriveCommoditySymbol(fundName);

	// Resolve account paths (configurable, with defaults)
	const fundAccount = config.fundAccount ?? "Assets:Investments:Conseq";
	const cashAccount = config.cashAccount ?? "Assets:Investments:Conseq:Cash";
	const feeAccount = config.feeAccount ?? "Expenses:Finance:Investments:Fees";
	const roundingAccount =
		config.roundingAccount ?? "Income:Investments:Conseq:Rounding";

	// Entry fee
	const feeEntry = cash.find((e) => e.description.includes("vstupní poplatek"));
	if (feeEntry) {
		transactions.push({
			id: `conseq-fee-${feeEntry.date}`,
			date: feeEntry.date,
			amount: { value: -feeEntry.amount, currency: "CZK" },
			description: "Vstupní poplatek",
			payee: "Conseq",
			category: feeAccount,
			account: cashAccount,
			source: cashFile,
		});
	}

	// Share purchases — commodity transactions
	const buyIdCounts = new Map<string, number>();
	for (const purchase of shares) {
		const baseId = `conseq-buy-${purchase.settlementDate}-${purchase.units}`;
		const count = buyIdCounts.get(baseId) ?? 0;
		buyIdCounts.set(baseId, count + 1);
		const id = count > 0 ? `${baseId}-${count + 1}` : baseId;

		transactions.push({
			id,
			date: purchase.settlementDate,
			amount: { value: -purchase.totalCZK, currency: "CZK" },
			description: `Nákup ${fundName}`,
			payee: "Conseq",
			account: cashAccount,
			source: sharesFile,
			commodity: {
				account: fundAccount,
				symbol: commoditySymbol,
				units: purchase.units,
				costPerUnit: {
					value: purchase.pricePerUnit,
					currency: "CZK",
				},
			},
		});

		prices.push({
			date: purchase.tradeDate,
			baseCurrency: commoditySymbol,
			quoteCurrency: "CZK",
			price: purchase.pricePerUnit,
			source: sharesFile,
		});
	}

	// Rounding adjustments
	const roundingEntries = cash.filter((e) =>
		e.description.includes("Zaokr. rozdíl"),
	);
	for (const entry of roundingEntries) {
		const value = entry.type === "Kredit" ? entry.amount : -entry.amount;
		transactions.push({
			id: `conseq-round-${entry.date}`,
			date: entry.date,
			amount: { value, currency: "CZK" },
			description: "Zaokrouhlení",
			payee: "Conseq",
			category: roundingAccount,
			account: cashAccount,
			source: cashFile,
		});
	}

	// Commodity definition
	const commodities: CommodityDefinition[] = [
		{
			symbol: commoditySymbol,
			name: fundName,
			isin,
			date: firstPurchase.tradeDate,
		},
	];

	// Balance assertions from account snapshot
	if (accountFile) {
		const snapshot = parseAccount(accountFile);

		// Balance assertions check at start of day in beancount,
		// so assert after all related transactions have settled.
		// Deposits from the bank may arrive days after the purchase
		// settlement, so we add a week buffer.
		const lastPurchase = shares[shares.length - 1];
		const lastDate = lastPurchase?.settlementDate ?? firstPurchase.tradeDate;
		const assertionDate = new Date(lastDate);
		assertionDate.setDate(assertionDate.getDate() + 7);
		const snapshotDate = assertionDate.toISOString().slice(0, 10);

		prices.push({
			date: snapshotDate,
			baseCurrency: commoditySymbol,
			quoteCurrency: "CZK",
			price: snapshot.pricePerUnit,
			source: accountFile,
		});

		balanceAssertions.push({
			date: snapshotDate,
			account: fundAccount,
			balance: { value: snapshot.units, currency: commoditySymbol },
			source: accountFile,
		});
		balanceAssertions.push({
			date: snapshotDate,
			account: cashAccount,
			balance: { value: snapshot.cashBalance, currency: "CZK" },
			source: accountFile,
		});
	}

	return {
		transactions,
		errors,
		prices,
		commodities,
		balanceAssertions,
	};
}
