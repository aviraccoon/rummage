/**
 * Revolut API client - pure functions for fetching transaction data.
 *
 * This replicates the HTTP requests made by Revolut's web app to retrieve
 * transaction data. Authentication is obtained by copying a cURL command
 * from browser DevTools.
 */

/** Authentication data extracted from a cURL command */
export interface RevolutAuth {
	cookie: string;
	deviceId: string;
	pocketId: string;
}

/** Raw transaction from Revolut API */
export interface RevolutTransaction {
	id: string;
	legId: string;
	type: string;
	state: string;
	startedDate: number;
	updatedDate?: number;
	completedDate?: number;
	createdDate?: number;
	currency: string;
	/** Amount in minor units (cents), negative = outflow */
	amount: number;
	fee?: number;
	balance?: number;
	description?: string;
	tag?: string;
	category?: string;
	countryCode?: string;
	rate?: number;
	merchant?: {
		id?: string;
		name?: string;
		category?: string;
		city?: string;
		country?: string;
		address?: string;
		mcc?: string;
	};
	counterpart?: {
		amount: number;
		currency: string;
	};
	account?: {
		id: string;
		type: string;
	};
	vault?: {
		id: string;
	};
	comment?: string;
}

/** Result of a fetch operation */
export interface FetchResult {
	transactions: RevolutTransaction[];
	currency: string;
	fetchedAt: string;
}

/** Error from Revolut API */
export interface RevolutApiError {
	message: string;
	code: number;
}

const API_BASE = "https://app.revolut.com/api/retail/user/current";
const TRANSACTIONS_ENDPOINT = `${API_BASE}/transactions/last`;
const BATCH_SIZE = 500;
const MAX_EMPTY_BATCHES = 3; // Stop after this many consecutive batches with no new transactions

/**
 * Parse a cURL command (from browser DevTools) to extract auth data.
 *
 * @example
 * const curl = `curl 'https://app.revolut.com/api/...' -H 'cookie: ...' -H 'x-device-id: ...'`;
 * const auth = parseCurlCommand(curl);
 */
export function parseCurlCommand(curl: string): RevolutAuth {
	// Normalize Windows CMD line continuations
	const normalized = curl
		.replace(/\^\^"/g, '"')
		.replace(/\^"/g, "'")
		.replace(/ \^/g, "");

	// Extract URL to get pocketId
	const urlMatch = normalized.match(/curl\s+['"]([^'"]+)/);
	if (!urlMatch?.[1]) {
		throw new Error("Could not find URL in cURL command");
	}

	const url = new URL(urlMatch[1]);
	const pocketId = url.searchParams.get("internalPocketId");
	if (!pocketId) {
		throw new Error(
			"Could not find internalPocketId in URL. Make sure you copied the cURL from a /transactions/last request.",
		);
	}

	// Extract cookie - try -b flag first, then Cookie header
	let cookie: string | undefined;
	const cookieBFlag = normalized.match(/-b\s+'([^']+)'/);
	if (cookieBFlag?.[1]) {
		cookie = cookieBFlag[1];
	} else {
		const cookieHeader = normalized.match(/['"]cookie:\s*([^'"]+)['"]/i);
		if (cookieHeader?.[1]) {
			cookie = cookieHeader[1];
		}
	}
	if (!cookie) {
		throw new Error(
			"Could not find cookie in cURL command. Make sure you copied with 'Copy as cURL'.",
		);
	}

	// Extract device ID
	const deviceIdMatch = normalized.match(/x-device-id:\s*([^'"}\s]+)/i);
	if (!deviceIdMatch?.[1]) {
		throw new Error("Could not find x-device-id header in cURL command.");
	}

	return {
		cookie,
		deviceId: deviceIdMatch[1],
		pocketId,
	};
}

/**
 * Build headers for Revolut API requests.
 */
function buildHeaders(auth: RevolutAuth): Record<string, string> {
	return {
		accept: "application/json",
		cookie: auth.cookie,
		"x-device-id": auth.deviceId,
		"x-browser-application": "WEB_CLIENT",
		"x-client-version": "100.0",
		"user-agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
	};
}

/**
 * Check if a response is an API error.
 */
function isApiError(data: unknown): data is RevolutApiError {
	return (
		typeof data === "object" &&
		data !== null &&
		"message" in data &&
		"code" in data
	);
}

export interface BatchResult {
	transactions: RevolutTransaction[];
	/** True if we hit end of history (404, empty, etc.) */
	endOfHistory: boolean;
}

/**
 * Fetch a single batch of transactions.
 *
 * @param auth - Authentication data
 * @param toTimestamp - Optional epoch ms to fetch transactions before
 * @returns Batch result with transactions and end-of-history flag
 */
export async function fetchTransactionBatch(
	auth: RevolutAuth,
	toTimestamp?: number,
): Promise<BatchResult> {
	const url = new URL(TRANSACTIONS_ENDPOINT);
	url.searchParams.set("count", String(BATCH_SIZE));
	url.searchParams.set("internalPocketId", auth.pocketId);
	if (toTimestamp) {
		url.searchParams.set("to", String(toTimestamp));
	}

	const response = await fetch(url.toString(), {
		headers: buildHeaders(auth),
	});

	// 404 or similar = end of history
	if (response.status === 404) {
		return { transactions: [], endOfHistory: true };
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const data: unknown = await response.json();

	if (isApiError(data)) {
		if (data.code === 9039) {
			throw new Error(
				"Access token expired. Please copy a fresh cURL command.",
			);
		}
		// Some API errors might indicate end of history
		if (data.code === 404 || data.message?.includes("not found")) {
			return { transactions: [], endOfHistory: true };
		}
		throw new Error(`Revolut API error: ${data.message} (code ${data.code})`);
	}

	if (!Array.isArray(data)) {
		throw new Error(`Unexpected response type: ${typeof data}`);
	}

	return { transactions: data as RevolutTransaction[], endOfHistory: false };
}

/**
 * Get the epoch timestamp for end of a given month.
 */
export function getMonthEndTimestamp(year: number, month: number): number {
	// Last day of month, 23:59:59
	const lastDay = new Date(year, month + 1, 0, 23, 59, 59);
	return lastDay.getTime();
}

export interface FetchProgress {
	total: number;
	month: string;
	added: number;
	status: "fetching" | "found" | "empty" | "end";
}

export interface FetchOptions {
	/** Progress callback with detailed info */
	onProgress?: (progress: FetchProgress) => void;
}

/**
 * Find the oldest startedDate from a list of transactions.
 */
function findOldestTimestamp(transactions: RevolutTransaction[]): number {
	let oldest = Infinity;
	for (const txn of transactions) {
		if (txn.startedDate < oldest) {
			oldest = txn.startedDate;
		}
	}
	return oldest;
}

/**
 * Format a timestamp as YYYY-MM-DD for progress display.
 */
function formatDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Fetch all transactions for a given auth context.
 * Paginates backward from newest to oldest using timestamps from each batch,
 * ensuring no gaps in the transaction history.
 *
 * @param auth - Authentication data
 * @param options - Fetch options
 * @returns All transactions found (deduplicated)
 */
export async function fetchAllTransactions(
	auth: RevolutAuth,
	options: FetchOptions = {},
): Promise<RevolutTransaction[]> {
	const { onProgress } = options;

	const seenIds = new Set<string>();
	const allTransactions: RevolutTransaction[] = [];
	let consecutiveEmptyBatches = 0;
	let toTimestamp: number | undefined;

	while (consecutiveEmptyBatches < MAX_EMPTY_BATCHES) {
		const label = toTimestamp ? formatDate(toTimestamp) : "latest";

		onProgress?.({
			total: allTransactions.length,
			month: label,
			added: 0,
			status: "fetching",
		});

		const result = await fetchTransactionBatch(auth, toTimestamp);

		// API indicated end of history
		if (result.endOfHistory) {
			onProgress?.({
				total: allTransactions.length,
				month: label,
				added: 0,
				status: "end",
			});
			break;
		}

		// Empty batch - can't determine next timestamp, so we're done
		if (result.transactions.length === 0) {
			onProgress?.({
				total: allTransactions.length,
				month: label,
				added: 0,
				status: "empty",
			});
			consecutiveEmptyBatches++;
			break;
		}

		// Add new transactions (deduplicating by legId)
		let addedThisBatch = 0;
		for (const txn of result.transactions) {
			if (!seenIds.has(txn.legId)) {
				seenIds.add(txn.legId);
				allTransactions.push(txn);
				addedThisBatch++;
			}
		}

		onProgress?.({
			total: allTransactions.length,
			month: label,
			added: addedThisBatch,
			status: addedThisBatch > 0 ? "found" : "empty",
		});

		if (addedThisBatch === 0) {
			consecutiveEmptyBatches++;
		} else {
			consecutiveEmptyBatches = 0;
		}

		// Use oldest transaction's timestamp - 1ms for next fetch to avoid re-fetching it
		const oldestInBatch = findOldestTimestamp(result.transactions);
		toTimestamp = oldestInBatch - 1;
	}

	return allTransactions;
}

/**
 * Detect currency from transactions (they all share the same currency per pocket).
 */
export function detectCurrency(transactions: RevolutTransaction[]): string {
	const first = transactions[0];
	if (!first) {
		throw new Error("No transactions to detect currency from");
	}
	return first.currency;
}

/**
 * Group transactions by year.
 *
 * @param transactions - Transactions to group
 * @returns Map of year string to transactions
 */
export function groupByYear(
	transactions: RevolutTransaction[],
): Map<string, RevolutTransaction[]> {
	const groups = new Map<string, RevolutTransaction[]>();

	for (const txn of transactions) {
		const date = new Date(txn.startedDate);
		const year = String(date.getFullYear());

		const existing = groups.get(year);
		if (existing) {
			existing.push(txn);
		} else {
			groups.set(year, [txn]);
		}
	}

	return groups;
}

/**
 * Deduplicate transactions by legId (Revolut's unique transaction identifier).
 *
 * @param existing - Existing transactions
 * @param incoming - New transactions to merge
 * @returns Merged and deduplicated transactions
 */
export function deduplicateTransactions(
	existing: RevolutTransaction[],
	incoming: RevolutTransaction[],
): { merged: RevolutTransaction[]; added: number; duplicates: number } {
	const existingIds = new Set(existing.map((t) => t.legId));
	const added: RevolutTransaction[] = [];
	let duplicates = 0;

	for (const txn of incoming) {
		if (existingIds.has(txn.legId)) {
			duplicates++;
		} else {
			added.push(txn);
			existingIds.add(txn.legId);
		}
	}

	return {
		merged: [...existing, ...added],
		added: added.length,
		duplicates,
	};
}

/**
 * Sort transactions by date (newest first).
 */
export function sortByDate(
	transactions: RevolutTransaction[],
): RevolutTransaction[] {
	return [...transactions].sort((a, b) => b.startedDate - a.startedDate);
}

/**
 * Convert epoch timestamp to ISO date string.
 */
export function epochToIsoDate(epoch: number): string {
	return new Date(epoch).toISOString().split("T")[0] ?? "";
}
