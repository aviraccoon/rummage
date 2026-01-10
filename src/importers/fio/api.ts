/**
 * Fio banka API client - pure functions for fetching transaction data.
 *
 * Uses the token-based API at fioapi.fio.cz (not the PSD2 API).
 * Tokens are generated at: ib.fio.cz → Nastavení → API
 */

export const BASE_URL = "https://fioapi.fio.cz/v1/rest";

/** Days to fetch by default (Fio requires auth for data older than 90 days) */
export const DEFAULT_DAYS = 89;

/** Account statement response from Fio API */
export interface FioAccountStatement {
	accountStatement: {
		info: FioAccountInfo;
		transactionList: {
			transaction: FioTransaction[] | null;
		};
	};
}

/** Account info from Fio API */
export interface FioAccountInfo {
	accountId: string;
	bankId: string;
	currency: string;
	iban: string;
	bic: string;
	openingBalance: number;
	closingBalance: number;
	dateStart: string;
	dateEnd: string;
	yearList: number | null;
	idList: number | null;
	idFrom: number | null;
	idTo: number | null;
	idLastDownload: number | null;
}

/**
 * Raw transaction from Fio API.
 * Each field is wrapped in an object with value, name, and id.
 */
export interface FioTransaction {
	column22: { value: number; name: "ID pohybu"; id: 22 }; // Transaction ID
	column0: { value: string; name: "Datum"; id: 0 }; // Date (YYYY-MM-DD+timezone)
	column1: { value: number; name: "Objem"; id: 1 }; // Amount
	column14: { value: string; name: "Měna"; id: 14 }; // Currency
	column2: { value: string | null; name: "Protiúčet"; id: 2 }; // Counter account
	column10: { value: string | null; name: "Název protiúčtu"; id: 10 }; // Counter account name
	column3: { value: string | null; name: "Kód banky"; id: 3 }; // Bank code
	column12: { value: string | null; name: "Název banky"; id: 12 }; // Bank name
	column4: { value: string | null; name: "KS"; id: 4 }; // Constant symbol
	column5: { value: string | null; name: "VS"; id: 5 }; // Variable symbol
	column6: { value: string | null; name: "SS"; id: 6 }; // Specific symbol
	column7: { value: string | null; name: "Uživatelská identifikace"; id: 7 }; // User identification
	column16: { value: string | null; name: "Zpráva pro příjemce"; id: 16 }; // Message for recipient
	column8: { value: string; name: "Typ"; id: 8 }; // Transaction type
	column9: { value: string | null; name: "Provedl"; id: 9 }; // Executor
	column18: { value: string | null; name: "Upřesnění"; id: 18 }; // Specification
	column25: { value: string | null; name: "Komentář"; id: 25 }; // Comment
	column26: { value: string | null; name: "BIC"; id: 26 }; // BIC
	column27: { value: string | null; name: "ID pokynu"; id: 27 }; // Instruction ID
	column17: { value: number | null; name: "ID pokynu"; id: 17 }; // Instruction ID (numeric)
}

/** Simplified transaction for easier processing */
export interface FioSimpleTransaction {
	id: number;
	date: string;
	amount: number;
	currency: string;
	counterAccount: string | null;
	counterAccountName: string | null;
	bankCode: string | null;
	bankName: string | null;
	constantSymbol: string | null;
	variableSymbol: string | null;
	specificSymbol: string | null;
	userIdentification: string | null;
	message: string | null;
	type: string;
	executor: string | null;
	specification: string | null;
	comment: string | null;
	bic: string | null;
	instructionId: string | null;
}

/** Supported export formats */
export type FioFormat = "xml" | "json" | "ofx" | "csv" | "gpc" | "html";

/** Options for fetching transactions */
export interface FetchOptions {
	from?: string;
	to?: string;
	incremental?: boolean;
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Get a date N days ago, formatted as YYYY-MM-DD.
 */
export function getDateDaysAgo(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() - days);
	return formatDate(date);
}

/**
 * Validate that a string looks like a Fio token (64 hex characters).
 */
export function isValidToken(token: string): boolean {
	return token.length === 64 && /^[a-zA-Z0-9]+$/.test(token);
}

/**
 * Build URL for fetching transactions by date range.
 */
export function buildPeriodUrl(
	token: string,
	from: string,
	to: string,
	format: FioFormat = "json",
): string {
	return `${BASE_URL}/periods/${token}/${from}/${to}/transactions.${format}`;
}

/**
 * Build URL for fetching transactions since last download.
 * Fio tracks this server-side per token.
 */
export function buildLastUrl(
	token: string,
	format: FioFormat = "json",
): string {
	return `${BASE_URL}/last/${token}/transactions.${format}`;
}

/**
 * Build URL for setting the last-download date marker.
 */
export function buildSetLastDateUrl(token: string, date: string): string {
	return `${BASE_URL}/set-last-date/${token}/${date}/`;
}

/**
 * Build URL for setting the last-download ID marker.
 */
export function buildSetLastIdUrl(token: string, id: number): string {
	return `${BASE_URL}/set-last-id/${token}/${id}/`;
}

/**
 * Convert raw Fio transaction to simplified format.
 */
export function simplifyTransaction(txn: FioTransaction): FioSimpleTransaction {
	return {
		id: txn.column22.value,
		date: txn.column0.value.split("+")[0] ?? txn.column0.value,
		amount: txn.column1.value,
		currency: txn.column14.value,
		counterAccount: txn.column2?.value ?? null,
		counterAccountName: txn.column10?.value ?? null,
		bankCode: txn.column3?.value ?? null,
		bankName: txn.column12?.value ?? null,
		constantSymbol: txn.column4?.value ?? null,
		variableSymbol: txn.column5?.value ?? null,
		specificSymbol: txn.column6?.value ?? null,
		userIdentification: txn.column7?.value ?? null,
		message: txn.column16?.value ?? null,
		type: txn.column8.value,
		executor: txn.column9?.value ?? null,
		specification: txn.column18?.value ?? null,
		comment: txn.column25?.value ?? null,
		bic: txn.column26?.value ?? null,
		instructionId: txn.column27?.value ?? null,
	};
}

/**
 * Extract transactions from API response.
 */
export function extractTransactions(
	response: FioAccountStatement,
): FioTransaction[] {
	return response.accountStatement.transactionList.transaction ?? [];
}

/**
 * Sort transactions by ID (ascending = oldest first).
 */
export function sortTransactionsById(
	transactions: FioTransaction[],
): FioTransaction[] {
	return [...transactions].sort((a, b) => a.column22.value - b.column22.value);
}

/**
 * Sort transactions by ID descending (newest first).
 */
export function sortTransactionsByIdDesc(
	transactions: FioTransaction[],
): FioTransaction[] {
	return [...transactions].sort((a, b) => b.column22.value - a.column22.value);
}

/**
 * Deduplicate transactions by ID.
 */
export function deduplicateTransactions(
	existing: FioTransaction[],
	incoming: FioTransaction[],
): { merged: FioTransaction[]; added: number; duplicates: number } {
	const existingIds = new Set(existing.map((t) => t.column22.value));
	const added: FioTransaction[] = [];
	let duplicates = 0;

	for (const txn of incoming) {
		if (existingIds.has(txn.column22.value)) {
			duplicates++;
		} else {
			added.push(txn);
			existingIds.add(txn.column22.value);
		}
	}

	return {
		merged: [...existing, ...added],
		added: added.length,
		duplicates,
	};
}

/**
 * Detect currency from account info.
 */
export function detectCurrency(response: FioAccountStatement): string {
	return response.accountStatement.info.currency;
}

/**
 * Get account IBAN from response.
 */
export function getAccountIban(response: FioAccountStatement): string {
	return response.accountStatement.info.iban;
}

/**
 * Parse Fio API error response.
 */
export function parseApiError(status: number, body: string): Error {
	if (status === 409) {
		return new Error(
			"Rate limited - wait 30 seconds between requests per token",
		);
	}
	if (status === 500) {
		return new Error(`Fio API error: ${body}`);
	}
	if (status === 404) {
		return new Error("Token not found or invalid");
	}
	return new Error(`HTTP ${status}: ${body}`);
}

/**
 * Fetch transactions from Fio API.
 *
 * @param token - 64-character API token
 * @param options - Fetch options
 * @returns Account statement with transactions
 */
export async function fetchTransactions(
	token: string,
	options: FetchOptions = {},
): Promise<FioAccountStatement> {
	let url: string;

	if (options.incremental) {
		url = buildLastUrl(token);
	} else {
		const from = options.from ?? getDateDaysAgo(DEFAULT_DAYS);
		const to = options.to ?? formatDate(new Date());
		url = buildPeriodUrl(token, from, to);
	}

	const response = await fetch(url);

	if (!response.ok) {
		const body = await response.text();
		throw parseApiError(response.status, body);
	}

	return response.json() as Promise<FioAccountStatement>;
}

/**
 * Set the last-download date marker on the server.
 * After this, incremental fetches will start from this date.
 */
export async function setLastDownloadDate(
	token: string,
	date: string,
): Promise<void> {
	const url = buildSetLastDateUrl(token, date);
	const response = await fetch(url);

	if (!response.ok) {
		const body = await response.text();
		throw parseApiError(response.status, body);
	}
}

/**
 * Set the last-download ID marker on the server.
 * After this, incremental fetches will start from this transaction ID.
 */
export async function setLastDownloadId(
	token: string,
	id: number,
): Promise<void> {
	const url = buildSetLastIdUrl(token, id);
	const response = await fetch(url);

	if (!response.ok) {
		const body = await response.text();
		throw parseApiError(response.status, body);
	}
}
