import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	deduplicateTransactions,
	detectCurrency,
	epochToIsoDate,
	fetchAllTransactions,
	fetchTransactionBatch,
	getMonthEndTimestamp,
	groupByYear,
	parseCurlCommand,
	type RevolutAuth,
	type RevolutTransaction,
	sortByDate,
} from "./api.ts";

function makeTxn(
	overrides: Partial<RevolutTransaction> = {},
): RevolutTransaction {
	return {
		id: "test-id",
		legId: "test-leg-id",
		type: "CARD_PAYMENT",
		state: "COMPLETED",
		startedDate: 1704067200000, // 2024-01-01 00:00:00 UTC
		currency: "USD",
		amount: -1000,
		...overrides,
	};
}

describe("parseCurlCommand", () => {
	test("parses bash-style cURL with cookie header", () => {
		const curl = `curl 'https://app.revolut.com/api/retail/user/current/transactions/last?count=50&internalPocketId=abc-123-def' \\
  -H 'cookie: session=xyz123; other=value' \\
  -H 'x-device-id: device-456'`;

		const auth = parseCurlCommand(curl);

		expect(auth.pocketId).toBe("abc-123-def");
		expect(auth.cookie).toBe("session=xyz123; other=value");
		expect(auth.deviceId).toBe("device-456");
	});

	test("parses cURL with -b cookie flag", () => {
		const curl = `curl 'https://app.revolut.com/api/retail/user/current/transactions/last?internalPocketId=pocket-789' \\
  -b 'session=cookie-value' \\
  -H 'x-device-id: my-device'`;

		const auth = parseCurlCommand(curl);

		expect(auth.pocketId).toBe("pocket-789");
		expect(auth.cookie).toBe("session=cookie-value");
		expect(auth.deviceId).toBe("my-device");
	});

	test("parses Windows CMD style cURL", () => {
		const curl = `curl "https://app.revolut.com/api/retail/user/current/transactions/last?internalPocketId=win-pocket" ^
  -H "cookie: win-cookie" ^
  -H "x-device-id: win-device"`;

		const auth = parseCurlCommand(curl);

		expect(auth.pocketId).toBe("win-pocket");
		expect(auth.cookie).toBe("win-cookie");
		expect(auth.deviceId).toBe("win-device");
	});

	test("throws if URL not found", () => {
		expect(() => parseCurlCommand("not a curl command")).toThrow(
			"Could not find URL",
		);
	});

	test("throws if pocketId missing", () => {
		const curl = `curl 'https://app.revolut.com/api/retail/user/current/transactions/last' -H 'cookie: x' -H 'x-device-id: y'`;

		expect(() => parseCurlCommand(curl)).toThrow("internalPocketId");
	});

	test("throws if cookie missing", () => {
		const curl = `curl 'https://app.revolut.com/api/retail/user/current/transactions/last?internalPocketId=abc' -H 'x-device-id: y'`;

		expect(() => parseCurlCommand(curl)).toThrow("cookie");
	});

	test("throws if device ID missing", () => {
		const curl = `curl 'https://app.revolut.com/api/retail/user/current/transactions/last?internalPocketId=abc' -H 'cookie: x'`;

		expect(() => parseCurlCommand(curl)).toThrow("x-device-id");
	});
});

describe("detectCurrency", () => {
	test("returns currency from first transaction", () => {
		const transactions = [
			makeTxn({ currency: "EUR" }),
			makeTxn({ currency: "EUR" }),
		];

		expect(detectCurrency(transactions)).toBe("EUR");
	});

	test("throws on empty array", () => {
		expect(() => detectCurrency([])).toThrow("No transactions");
	});
});

describe("groupByYear", () => {
	test("groups transactions by year", () => {
		const transactions = [
			makeTxn({ legId: "1", startedDate: 1704067200000 }), // 2024-01-01
			makeTxn({ legId: "2", startedDate: 1706745600000 }), // 2024-02-01
			makeTxn({ legId: "3", startedDate: 1672531200000 }), // 2023-01-01
		];

		const groups = groupByYear(transactions);

		expect(groups.size).toBe(2);
		expect(groups.get("2024")?.length).toBe(2);
		expect(groups.get("2023")?.length).toBe(1);
	});

	test("handles empty array", () => {
		const groups = groupByYear([]);
		expect(groups.size).toBe(0);
	});
});

describe("deduplicateTransactions", () => {
	test("adds new transactions", () => {
		const existing = [makeTxn({ legId: "existing-1" })];
		const incoming = [makeTxn({ legId: "new-1" }), makeTxn({ legId: "new-2" })];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged.length).toBe(3);
		expect(result.added).toBe(2);
		expect(result.duplicates).toBe(0);
	});

	test("skips duplicates", () => {
		const existing = [makeTxn({ legId: "txn-1" }), makeTxn({ legId: "txn-2" })];
		const incoming = [
			makeTxn({ legId: "txn-2" }), // duplicate
			makeTxn({ legId: "txn-3" }), // new
		];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged.length).toBe(3);
		expect(result.added).toBe(1);
		expect(result.duplicates).toBe(1);
	});

	test("handles all duplicates", () => {
		const existing = [makeTxn({ legId: "txn-1" })];
		const incoming = [makeTxn({ legId: "txn-1" })];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged.length).toBe(1);
		expect(result.added).toBe(0);
		expect(result.duplicates).toBe(1);
	});

	test("handles empty existing", () => {
		const incoming = [makeTxn({ legId: "txn-1" }), makeTxn({ legId: "txn-2" })];

		const result = deduplicateTransactions([], incoming);

		expect(result.merged.length).toBe(2);
		expect(result.added).toBe(2);
	});
});

describe("sortByDate", () => {
	test("sorts newest first", () => {
		const transactions = [
			makeTxn({ legId: "old", startedDate: 1672531200000 }), // 2023-01-01
			makeTxn({ legId: "new", startedDate: 1704067200000 }), // 2024-01-01
			makeTxn({ legId: "mid", startedDate: 1688169600000 }), // 2023-07-01
		];

		const sorted = sortByDate(transactions);

		expect(sorted[0]?.legId).toBe("new");
		expect(sorted[1]?.legId).toBe("mid");
		expect(sorted[2]?.legId).toBe("old");
	});

	test("does not mutate original", () => {
		const transactions = [
			makeTxn({ legId: "old", startedDate: 1672531200000 }),
			makeTxn({ legId: "new", startedDate: 1704067200000 }),
		];

		sortByDate(transactions);

		expect(transactions[0]?.legId).toBe("old");
	});
});

describe("epochToIsoDate", () => {
	test("converts epoch ms to ISO date", () => {
		// 2024-01-01 00:00:00 UTC
		expect(epochToIsoDate(1704067200000)).toBe("2024-01-01");
	});

	test("handles different dates", () => {
		// 2023-07-15 12:30:00 UTC
		expect(epochToIsoDate(1689423000000)).toBe("2023-07-15");
	});
});

describe("getMonthEndTimestamp", () => {
	test("returns end of month timestamp", () => {
		// January 2024
		const ts = getMonthEndTimestamp(2024, 0);
		const date = new Date(ts);

		expect(date.getFullYear()).toBe(2024);
		expect(date.getMonth()).toBe(0);
		expect(date.getDate()).toBe(31); // January has 31 days
		expect(date.getHours()).toBe(23);
		expect(date.getMinutes()).toBe(59);
		expect(date.getSeconds()).toBe(59);
	});

	test("handles February correctly", () => {
		// February 2024 (leap year)
		const ts = getMonthEndTimestamp(2024, 1);
		const date = new Date(ts);

		expect(date.getDate()).toBe(29); // Leap year
	});

	test("handles non-leap year February", () => {
		// February 2023 (not a leap year)
		const ts = getMonthEndTimestamp(2023, 1);
		const date = new Date(ts);

		expect(date.getDate()).toBe(28);
	});
});

const mockAuth: RevolutAuth = {
	cookie: "test-cookie",
	deviceId: "test-device",
	pocketId: "test-pocket",
};

describe("fetchTransactionBatch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("fetches transactions successfully", async () => {
		const mockTransactions = [makeTxn({ legId: "txn-1" })];
		const mockFn = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(mockTransactions),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchTransactionBatch(mockAuth);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]?.legId).toBe("txn-1");
		expect(result.endOfHistory).toBe(false);
	});

	test("includes timestamp when provided", async () => {
		const mockFn = mock((_url: string) =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve([]),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await fetchTransactionBatch(mockAuth, 1704067200000);

		expect(mockFn.mock.calls[0]?.[0]).toContain("to=1704067200000");
	});

	test("returns endOfHistory on 404", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchTransactionBatch(mockAuth);

		expect(result.transactions).toHaveLength(0);
		expect(result.endOfHistory).toBe(true);
	});

	test("throws on expired token (code 9039)", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ message: "Expired", code: 9039 }),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactionBatch(mockAuth)).rejects.toThrow(
			"Access token expired",
		);
	});

	test("throws on HTTP error", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactionBatch(mockAuth)).rejects.toThrow("HTTP 500");
	});

	test("throws on unexpected response type", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve("not an array"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactionBatch(mockAuth)).rejects.toThrow(
			"Unexpected response type",
		);
	});

	test("handles API error with not found message as end of history", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({ message: "Resource not found", code: 404 }),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchTransactionBatch(mockAuth);

		expect(result.endOfHistory).toBe(true);
	});
});

describe("fetchAllTransactions", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("fetches and deduplicates transactions", async () => {
		// First call returns some transactions
		// Subsequent calls return end of history
		let callCount = 0;
		const mockFn = mock(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve([
							makeTxn({ legId: "txn-1" }),
							makeTxn({ legId: "txn-2" }),
						]),
				} as Response);
			}
			// Return 404 to end history
			return Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response);
		});
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchAllTransactions(mockAuth);

		expect(result).toHaveLength(2);
	});

	test("calls progress callback", async () => {
		let callCount = 0;
		const mockFn = mock(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve([makeTxn({ legId: "txn-1" })]),
				} as Response);
			}
			return Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response);
		});
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const progressCalls: string[] = [];
		await fetchAllTransactions(mockAuth, {
			onProgress: (p) => progressCalls.push(p.status),
		});

		expect(progressCalls).toContain("fetching");
		expect(progressCalls).toContain("found");
	});

	test("stops after endOfHistory from initial fetch", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchAllTransactions(mockAuth);

		expect(result).toHaveLength(0);
		expect(mockFn).toHaveBeenCalledTimes(1);
	});

	test("paginates using oldest transaction timestamp", async () => {
		let callCount = 0;
		const mockFn = mock((url: string) => {
			callCount++;
			if (callCount === 1) {
				// First fetch (latest) - no 'to' param
				expect(url).not.toContain("to=");
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve([
							makeTxn({ legId: "latest-1", startedDate: 1704153600000 }), // 2024-01-02
						]),
				} as Response);
			}
			if (callCount === 2) {
				// Second fetch should use timestamp from oldest transaction - 1ms
				expect(url).toContain("to=1704153599999"); // 1704153600000 - 1
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve([
							makeTxn({ legId: "older-1", startedDate: 1704067200000 }), // 2024-01-01
						]),
				} as Response);
			}
			// End of history
			return Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response);
		});
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchAllTransactions(mockAuth);

		expect(result).toHaveLength(2);
		expect(result.map((t) => t.legId)).toContain("latest-1");
		expect(result.map((t) => t.legId)).toContain("older-1");
	});

	test("stops on empty batch", async () => {
		let callCount = 0;
		const mockFn = mock(() => {
			callCount++;
			if (callCount === 1) {
				// First fetch has transactions
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve([makeTxn({ legId: "txn-1" })]),
				} as Response);
			}
			// Second fetch returns empty (end of transaction history)
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve([]),
			} as Response);
		});
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const progressCalls: Array<{ month: string; status: string }> = [];
		const result = await fetchAllTransactions(mockAuth, {
			onProgress: (p) =>
				progressCalls.push({ month: p.month, status: p.status }),
		});

		expect(result).toHaveLength(1);
		// Should stop after the empty batch
		expect(mockFn).toHaveBeenCalledTimes(2);
		const emptyCount = progressCalls.filter((p) => p.status === "empty").length;
		expect(emptyCount).toBe(1);
	});

	test("handles API error (non-404) during fetch", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ message: "Some API error", code: 1234 }),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchAllTransactions(mockAuth)).rejects.toThrow(
			"Revolut API error",
		);
	});
});
