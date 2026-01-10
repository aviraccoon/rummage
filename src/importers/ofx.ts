/**
 * Shared OFX parser and generic importer.
 * Parses standard OFX 2.x XML format into a normalized structure.
 * Works standalone or can be customized by bank-specific importers.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportResult, Transaction } from "../types.ts";

/** Raw OFX transaction as parsed from file */
export interface OfxTransaction {
	/** Transaction type: DEBIT, CREDIT, XFER, POS, FEE, etc. */
	type: string;
	/** Posted date as ISO string YYYY-MM-DD */
	date: string;
	/** Amount (negative = outflow, positive = inflow) */
	amount: number;
	/** Financial institution transaction ID */
	fitId: string;
	/** Transaction name/type from bank */
	name: string;
	/** Memo/description (optional) */
	memo?: string;
	/** Destination bank info (for transfers) */
	bankAcctTo?: {
		bankId: string;
		acctId: string;
		acctType: string;
	};
}

/** Raw OFX statement as parsed from file */
export interface OfxStatement {
	/** Currency code */
	currency: string;
	/** Bank ID */
	bankId: string;
	/** Account ID */
	accountId: string;
	/** Account type */
	accountType: string;
	/** Statement date range */
	dateRange: {
		start: string;
		end: string;
	};
	/** Transactions */
	transactions: OfxTransaction[];
}

export interface OfxParseResult {
	statement: OfxStatement;
	errors: string[];
}

/**
 * Parse OFX date format: 20251204000000.000[+01.00:CET] → 2025-12-04
 */
function parseOfxDate(dateStr: string): string {
	// Extract YYYYMMDD from start
	const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})/);
	if (!match) {
		throw new Error(`Invalid OFX date: ${dateStr}`);
	}
	return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Extract text content from a simple XML element.
 * This is a naive parser that works for OFX's simple structure.
 */
function extractElement(xml: string, tag: string): string | undefined {
	const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
	const match = xml.match(regex);
	return match?.[1]?.trim();
}

/**
 * Extract a block between opening and closing tags.
 */
function extractBlock(xml: string, tag: string): string | undefined {
	const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
	const match = xml.match(regex);
	return match?.[1];
}

/**
 * Extract all blocks matching a tag.
 */
function extractAllBlocks(xml: string, tag: string): string[] {
	const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
	return [...xml.matchAll(regex)].map((m) => m[1] ?? "");
}

/**
 * Parse a single STMTTRN block into an OfxTransaction.
 */
function parseTransaction(block: string): OfxTransaction {
	const type = extractElement(block, "TRNTYPE") ?? "OTHER";
	const dateRaw = extractElement(block, "DTPOSTED");
	const amountRaw = extractElement(block, "TRNAMT");
	const fitId = extractElement(block, "FITID") ?? "";
	const name = extractElement(block, "NAME") ?? "";
	const memo = extractElement(block, "MEMO");

	if (!dateRaw || !amountRaw) {
		throw new Error("Transaction missing required fields DTPOSTED or TRNAMT");
	}

	const date = parseOfxDate(dateRaw);
	const amount = Number.parseFloat(amountRaw);

	// Parse destination account if present
	const bankAcctToBlock = extractBlock(block, "BANKACCTTO");
	let bankAcctTo: OfxTransaction["bankAcctTo"];
	if (bankAcctToBlock) {
		bankAcctTo = {
			bankId: extractElement(bankAcctToBlock, "BANKID") ?? "",
			acctId: extractElement(bankAcctToBlock, "ACCTID") ?? "",
			acctType: extractElement(bankAcctToBlock, "ACCTTYPE") ?? "",
		};
	}

	return {
		type,
		date,
		amount,
		fitId,
		name,
		memo,
		bankAcctTo,
	};
}

/**
 * Parse an OFX file content into structured data.
 */
export function parseOfx(content: string): OfxParseResult {
	const errors: string[] = [];

	// Find the statement response
	const stmtrs = extractBlock(content, "STMTRS");
	if (!stmtrs) {
		throw new Error("No STMTRS block found in OFX file");
	}

	// Extract currency
	const currency = extractElement(stmtrs, "CURDEF") ?? "USD";

	// Extract account info
	const bankAcctFrom = extractBlock(stmtrs, "BANKACCTFROM");
	if (!bankAcctFrom) {
		throw new Error("No BANKACCTFROM block found");
	}
	const bankId = extractElement(bankAcctFrom, "BANKID") ?? "";
	const accountId = extractElement(bankAcctFrom, "ACCTID") ?? "";
	const accountType = extractElement(bankAcctFrom, "ACCTTYPE") ?? "CHECKING";

	// Extract transaction list
	const bankTranList = extractBlock(stmtrs, "BANKTRANLIST");
	if (!bankTranList) {
		throw new Error("No BANKTRANLIST block found");
	}

	// Extract date range
	const dtStartRaw = extractElement(bankTranList, "DTSTART");
	const dtEndRaw = extractElement(bankTranList, "DTEND");
	const dateRange = {
		start: dtStartRaw ? parseOfxDate(dtStartRaw) : "",
		end: dtEndRaw ? parseOfxDate(dtEndRaw) : "",
	};

	// Parse all transactions
	const transactionBlocks = extractAllBlocks(bankTranList, "STMTTRN");
	const transactions: OfxTransaction[] = [];

	for (const block of transactionBlocks) {
		try {
			transactions.push(parseTransaction(block));
		} catch (e) {
			errors.push(
				`Failed to parse transaction: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	return {
		statement: {
			currency,
			bankId,
			accountId,
			accountType,
			dateRange,
			transactions,
		},
		errors,
	};
}

// ============================================================================
// Generic OFX Importer
// ============================================================================

/**
 * Map account IDs to rummage account paths.
 * If not provided, accounts are auto-generated from OFX data.
 */
export interface OfxAccountMapping {
	[accountId: string]: {
		account: string;
		currency: string;
	};
}

export interface OfxImportOptions {
	/** Custom account mapping. If not provided, auto-generates from OFX data. */
	accountMapping?: OfxAccountMapping;
	/** Prefix for transaction IDs and auto-generated accounts (default: "ofx") */
	bankPrefix?: string;
	/** Base account path for auto-generated accounts (default: "Assets:Bank-{bankId}") */
	accountBase?: string;
}

/**
 * Build transaction description from OFX name and memo.
 * Most banks put useful info in memo, name is often just transaction type.
 */
function buildDescription(name: string, memo?: string): string {
	if (memo) {
		return memo;
	}
	return name;
}

/**
 * Import transactions from an OFX file.
 * Works with any standard OFX file - auto-generates account names if no mapping provided.
 */
export function importOfxFile(
	filePath: string,
	options: OfxImportOptions = {},
): ImportResult {
	const content = readFileSync(filePath, "utf-8");
	const { statement, errors } = parseOfx(content);

	const bankPrefix = options.bankPrefix ?? "ofx";
	const accountMapping = options.accountMapping;
	const accountBase = options.accountBase;

	// Determine account - use mapping if provided, otherwise auto-generate
	let accountName: string;
	let currency: string;

	const mappedAccount = accountMapping?.[statement.accountId];
	if (mappedAccount) {
		accountName = mappedAccount.account;
		currency = mappedAccount.currency;
	} else if (accountBase) {
		// Use provided base: {accountBase}:{currency}
		currency = statement.currency;
		accountName = `${accountBase}:${currency}`;
	} else {
		// Auto-generate: Assets:Bank-{bankId}:{currency}
		currency = statement.currency;
		accountName = `Assets:Bank-${statement.bankId}:${currency}`;
	}

	const transactions: Transaction[] = [];

	for (const ofxTxn of statement.transactions) {
		const txn: Transaction = {
			id: `${bankPrefix}-${statement.accountId}-${ofxTxn.fitId}`,
			date: ofxTxn.date,
			amount: {
				value: ofxTxn.amount,
				currency,
			},
			description: buildDescription(ofxTxn.name, ofxTxn.memo),
			rawName: ofxTxn.name,
			rawMemo: ofxTxn.memo,
			account: accountName,
			source: filePath,
			metadata: {
				ofxType: ofxTxn.type,
				fitId: ofxTxn.fitId,
				bankAcctTo: ofxTxn.bankAcctTo,
			},
		};

		transactions.push(txn);
	}

	return {
		transactions,
		errors: errors.map((msg) => ({
			source: filePath,
			message: msg,
		})),
	};
}

/**
 * Import all OFX files from a directory.
 */
export function importOfxDirectory(
	dirPath: string,
	options: OfxImportOptions = {},
): ImportResult {
	const files = readdirSync(dirPath) as string[];
	const ofxFiles = files.filter((f: string) =>
		f.toLowerCase().endsWith(".ofx"),
	);

	const allTransactions: Transaction[] = [];
	const allErrors: ImportResult["errors"] = [];

	for (const file of ofxFiles) {
		const result = importOfxFile(join(dirPath, file), options);
		allTransactions.push(...result.transactions);
		allErrors.push(...result.errors);
	}

	// Sort by date
	allTransactions.sort((a, b) => a.date.localeCompare(b.date));

	return {
		transactions: allTransactions,
		errors: allErrors,
	};
}
