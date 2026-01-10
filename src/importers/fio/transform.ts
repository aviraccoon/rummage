/**
 * Fio banka importer.
 * Handles both JSON (from API) and OFX (manual download) formats.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BalanceAssertion,
	ImportResult,
	Transaction,
} from "../../types.ts";
import {
	importOfxDirectory,
	importOfxFile,
	type OfxImportOptions,
} from "../ofx.ts";
import type {
	FioAccountInfo,
	FioAccountStatement,
	FioTransaction,
} from "./api.ts";

/** Re-export for convenience */
export type FioAccountMapping = OfxImportOptions["accountMapping"];
export type FioImportOptions = OfxImportOptions;

export interface FioJsonImportOptions {
	/** Base account path (default: "Assets:Fio") */
	accountBase?: string;
}

/**
 * Import transactions from a Fio OFX file.
 * Uses generic OFX importer - Fio follows standard OFX format.
 */
export function importFioOfx(filePath: string, options: FioImportOptions = {}) {
	return importOfxFile(filePath, {
		...options,
		bankPrefix: options.bankPrefix ?? "fio",
	});
}

/**
 * Extract date from Fio date string (strips timezone).
 */
function parseDate(dateStr: string): string {
	// Format: "2024-01-15+0100" → "2024-01-15"
	const [date] = dateStr.split("+");
	return date ?? dateStr;
}

/**
 * Extract closing balance assertion from Fio account info.
 * Uses the closing balance at the end of the statement period.
 * Date is the day AFTER dateEnd because beancount checks at START of day.
 */
function extractBalanceAssertion(
	info: FioAccountInfo,
	accountName: string,
	source: string,
): BalanceAssertion {
	// Balance assertion date is the day AFTER the statement end
	// because beancount checks balance at the START of the day
	const endDate = new Date(parseDate(info.dateEnd));
	endDate.setDate(endDate.getDate() + 1);
	const assertionDate = endDate.toISOString().slice(0, 10);

	return {
		date: assertionDate,
		account: accountName,
		balance: {
			value: info.closingBalance,
			currency: info.currency,
		},
		source,
	};
}

/**
 * Extract opening balance from Fio account info.
 * Uses the opening balance at the start of the statement period.
 */
function extractOpeningBalance(
	info: FioAccountInfo,
	accountName: string,
	source: string,
): BalanceAssertion {
	return {
		date: parseDate(info.dateStart),
		account: accountName,
		balance: {
			value: info.openingBalance,
			currency: info.currency,
		},
		source,
	};
}

/**
 * Build description from available fields.
 */
function buildDescription(txn: FioTransaction): string {
	// Priority: user identification > message > counter account name > type
	return (
		txn.column7?.value ??
		txn.column16?.value ??
		txn.column10?.value ??
		txn.column8.value
	);
}

/**
 * Import a single Fio JSON transaction.
 */
function importTransaction(
	txn: FioTransaction,
	accountName: string,
	source: string,
): Transaction {
	const result: Transaction = {
		id: `fio-${txn.column22.value}`,
		date: parseDate(txn.column0.value),
		amount: {
			value: txn.column1.value,
			currency: txn.column14.value,
		},
		description: buildDescription(txn),
		account: accountName,
		source,
	};

	// Store raw fields for rule matching
	if (txn.column7?.value) {
		result.rawName = txn.column7.value;
	}
	if (txn.column16?.value) {
		result.rawMemo = txn.column16.value;
	}

	// Store rich metadata including Czech payment symbols
	result.metadata = {
		fioId: txn.column22.value,
		fioType: txn.column8.value,
		counterAccount: txn.column2?.value,
		counterAccountName: txn.column10?.value,
		bankCode: txn.column3?.value,
		bankName: txn.column12?.value,
		variableSymbol: txn.column5?.value,
		constantSymbol: txn.column4?.value,
		specificSymbol: txn.column6?.value,
		bic: txn.column26?.value,
		executor: txn.column9?.value,
		specification: txn.column18?.value,
		comment: txn.column25?.value,
	};

	return result;
}

/**
 * Import transactions from a Fio JSON file (API export).
 */
export function importFioJson(
	filePath: string,
	options: FioJsonImportOptions = {},
): ImportResult {
	const content = readFileSync(filePath, "utf-8");
	const data = JSON.parse(content) as FioAccountStatement;

	const info = data.accountStatement.info;
	const rawTransactions =
		data.accountStatement.transactionList.transaction ?? [];

	const accountBase = options.accountBase ?? "Assets:Fio";
	const accountName = `${accountBase}:${info.currency}`;

	const transactions: Transaction[] = [];
	const errors: ImportResult["errors"] = [];

	for (const txn of rawTransactions) {
		try {
			transactions.push(importTransaction(txn, accountName, filePath));
		} catch (e) {
			errors.push({
				source: filePath,
				message: `Failed to import transaction ${txn.column22?.value ?? "unknown"}: ${e instanceof Error ? e.message : String(e)}`,
				raw: JSON.stringify(txn),
			});
		}
	}

	// Sort by date
	transactions.sort((a, b) => a.date.localeCompare(b.date));

	// Extract balance assertions from statement info
	const balanceAssertion = extractBalanceAssertion(info, accountName, filePath);
	const openingBalance = extractOpeningBalance(info, accountName, filePath);

	return {
		transactions,
		errors,
		balanceAssertions: [balanceAssertion],
		openingBalances: [openingBalance],
	};
}

/**
 * Import all files from a Fio directory.
 * Handles both JSON (API) and OFX (manual) formats.
 */
export function importFioDirectory(
	dirPath: string,
	options: FioImportOptions & FioJsonImportOptions = {},
): ImportResult {
	const files = readdirSync(dirPath) as string[];

	const jsonFiles = files.filter((f) => f.endsWith(".json"));
	const ofxFiles = files.filter((f) => f.endsWith(".ofx"));

	const allTransactions: Transaction[] = [];
	const allErrors: ImportResult["errors"] = [];
	const allBalanceAssertions: BalanceAssertion[] = [];
	const allOpeningBalances: BalanceAssertion[] = [];

	// Import JSON files (from API)
	for (const file of jsonFiles) {
		const result = importFioJson(join(dirPath, file), options);
		allTransactions.push(...result.transactions);
		allErrors.push(...result.errors);
		if (result.balanceAssertions) {
			allBalanceAssertions.push(...result.balanceAssertions);
		}
		if (result.openingBalances) {
			allOpeningBalances.push(...result.openingBalances);
		}
	}

	// Import OFX files (manual downloads)
	// Note: OFX balance extraction could be added later if needed
	if (ofxFiles.length > 0) {
		const ofxResult = importOfxDirectory(dirPath, {
			...options,
			bankPrefix: options.bankPrefix ?? "fio",
		});
		allTransactions.push(...ofxResult.transactions);
		allErrors.push(...ofxResult.errors);
	}

	// Deduplicate by ID (JSON and OFX might have overlapping transactions)
	const seen = new Set<string>();
	const deduplicated = allTransactions.filter((txn) => {
		if (seen.has(txn.id)) {
			return false;
		}
		seen.add(txn.id);
		return true;
	});

	// Sort by date
	deduplicated.sort((a, b) => a.date.localeCompare(b.date));

	return {
		transactions: deduplicated,
		errors: allErrors,
		balanceAssertions:
			allBalanceAssertions.length > 0 ? allBalanceAssertions : undefined,
		openingBalances:
			allOpeningBalances.length > 0 ? allOpeningBalances : undefined,
	};
}
