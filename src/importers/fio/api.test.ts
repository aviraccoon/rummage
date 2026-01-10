import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	buildLastUrl,
	buildPeriodUrl,
	buildSetLastDateUrl,
	buildSetLastIdUrl,
	deduplicateTransactions,
	detectCurrency,
	extractTransactions,
	type FioAccountStatement,
	type FioTransaction,
	fetchTransactions,
	formatDate,
	getAccountIban,
	getDateDaysAgo,
	isValidToken,
	parseApiError,
	setLastDownloadDate,
	setLastDownloadId,
	simplifyTransaction,
	sortTransactionsById,
	sortTransactionsByIdDesc,
} from "./api.ts";

function makeTxn(overrides: Partial<FioTransaction> = {}): FioTransaction {
	return {
		column22: { value: 12345, name: "ID pohybu", id: 22 },
		column0: { value: "2024-01-15+0100", name: "Datum", id: 0 },
		column1: { value: -500.0, name: "Objem", id: 1 },
		column14: { value: "CZK", name: "Měna", id: 14 },
		column2: { value: "123456789", name: "Protiúčet", id: 2 },
		column10: { value: "Jan Novák", name: "Název protiúčtu", id: 10 },
		column3: { value: "0100", name: "Kód banky", id: 3 },
		column12: { value: "Komerční banka", name: "Název banky", id: 12 },
		column4: { value: "0308", name: "KS", id: 4 },
		column5: { value: "1234567890", name: "VS", id: 5 },
		column6: { value: null, name: "SS", id: 6 },
		column7: {
			value: "Payment for services",
			name: "Uživatelská identifikace",
			id: 7,
		},
		column16: { value: "Thank you", name: "Zpráva pro příjemce", id: 16 },
		column8: { value: "Bezhotovostní platba", name: "Typ", id: 8 },
		column9: { value: null, name: "Provedl", id: 9 },
		column18: { value: null, name: "Upřesnění", id: 18 },
		column25: { value: null, name: "Komentář", id: 25 },
		column26: { value: "KOMBCZPP", name: "BIC", id: 26 },
		column27: { value: null, name: "ID pokynu", id: 27 },
		column17: { value: null, name: "ID pokynu", id: 17 },
		...overrides,
	};
}

function makeStatement(
	transactions: FioTransaction[] = [],
	currency = "CZK",
): FioAccountStatement {
	return {
		accountStatement: {
			info: {
				accountId: "2900123456",
				bankId: "2010",
				currency,
				iban: "CZ6520100000002900123456",
				bic: "FIOBCZPP",
				openingBalance: 10000.0,
				closingBalance: 9500.0,
				dateStart: "2024-01-01",
				dateEnd: "2024-01-31",
				yearList: null,
				idList: null,
				idFrom: 12340,
				idTo: 12350,
				idLastDownload: null,
			},
			transactionList: {
				transaction: transactions.length > 0 ? transactions : null,
			},
		},
	};
}

describe("formatDate", () => {
	test("formats date as YYYY-MM-DD", () => {
		const date = new Date(2024, 0, 15); // Jan 15, 2024
		expect(formatDate(date)).toBe("2024-01-15");
	});

	test("pads single-digit month and day", () => {
		const date = new Date(2024, 2, 5); // Mar 5, 2024
		expect(formatDate(date)).toBe("2024-03-05");
	});

	test("handles December correctly", () => {
		const date = new Date(2024, 11, 31); // Dec 31, 2024
		expect(formatDate(date)).toBe("2024-12-31");
	});
});

describe("getDateDaysAgo", () => {
	test("returns date in YYYY-MM-DD format", () => {
		const result = getDateDaysAgo(89);
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns correct number of days ago", () => {
		const result = getDateDaysAgo(89);
		const resultDate = new Date(result);
		const now = new Date();
		const diffMs = now.getTime() - resultDate.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
		expect(diffDays).toBe(89);
	});
});

describe("isValidToken", () => {
	test("accepts valid 64-character alphanumeric token", () => {
		const token = "a".repeat(64);
		expect(isValidToken(token)).toBe(true);
	});

	test("accepts mixed case alphanumeric", () => {
		const token = "aAbBcCdD1234567890".repeat(4).slice(0, 64);
		expect(isValidToken(token)).toBe(true);
	});

	test("rejects token with wrong length", () => {
		expect(isValidToken("abc123")).toBe(false);
		expect(isValidToken("a".repeat(63))).toBe(false);
		expect(isValidToken("a".repeat(65))).toBe(false);
	});

	test("rejects token with special characters", () => {
		const token = `${"a".repeat(63)}-`;
		expect(isValidToken(token)).toBe(false);
	});

	test("rejects empty string", () => {
		expect(isValidToken("")).toBe(false);
	});
});

describe("buildPeriodUrl", () => {
	test("builds correct URL with dates", () => {
		const url = buildPeriodUrl("mytoken", "2024-01-01", "2024-01-31");
		expect(url).toBe(
			"https://fioapi.fio.cz/v1/rest/periods/mytoken/2024-01-01/2024-01-31/transactions.json",
		);
	});

	test("supports different formats", () => {
		const xmlUrl = buildPeriodUrl("mytoken", "2024-01-01", "2024-01-31", "xml");
		expect(xmlUrl).toContain("/transactions.xml");

		const ofxUrl = buildPeriodUrl("mytoken", "2024-01-01", "2024-01-31", "ofx");
		expect(ofxUrl).toContain("/transactions.ofx");
	});
});

describe("buildLastUrl", () => {
	test("builds correct URL for incremental fetch", () => {
		const url = buildLastUrl("mytoken");
		expect(url).toBe(
			"https://fioapi.fio.cz/v1/rest/last/mytoken/transactions.json",
		);
	});

	test("supports different formats", () => {
		const csvUrl = buildLastUrl("mytoken", "csv");
		expect(csvUrl).toContain("/transactions.csv");
	});
});

describe("buildSetLastDateUrl", () => {
	test("builds correct URL", () => {
		const url = buildSetLastDateUrl("mytoken", "2024-01-15");
		expect(url).toBe(
			"https://fioapi.fio.cz/v1/rest/set-last-date/mytoken/2024-01-15/",
		);
	});
});

describe("buildSetLastIdUrl", () => {
	test("builds correct URL", () => {
		const url = buildSetLastIdUrl("mytoken", 12345);
		expect(url).toBe(
			"https://fioapi.fio.cz/v1/rest/set-last-id/mytoken/12345/",
		);
	});
});

describe("simplifyTransaction", () => {
	test("extracts all fields correctly", () => {
		const raw = makeTxn();
		const simple = simplifyTransaction(raw);

		expect(simple.id).toBe(12345);
		expect(simple.date).toBe("2024-01-15"); // Strips timezone
		expect(simple.amount).toBe(-500.0);
		expect(simple.currency).toBe("CZK");
		expect(simple.counterAccount).toBe("123456789");
		expect(simple.counterAccountName).toBe("Jan Novák");
		expect(simple.bankCode).toBe("0100");
		expect(simple.bankName).toBe("Komerční banka");
		expect(simple.constantSymbol).toBe("0308");
		expect(simple.variableSymbol).toBe("1234567890");
		expect(simple.specificSymbol).toBeNull();
		expect(simple.userIdentification).toBe("Payment for services");
		expect(simple.message).toBe("Thank you");
		expect(simple.type).toBe("Bezhotovostní platba");
		expect(simple.bic).toBe("KOMBCZPP");
	});

	test("handles null values", () => {
		const raw = makeTxn({
			column2: { value: null, name: "Protiúčet", id: 2 },
			column10: { value: null, name: "Název protiúčtu", id: 10 },
		});
		const simple = simplifyTransaction(raw);

		expect(simple.counterAccount).toBeNull();
		expect(simple.counterAccountName).toBeNull();
	});

	test("strips timezone from date", () => {
		const raw = makeTxn({
			column0: { value: "2024-06-15+0200", name: "Datum", id: 0 },
		});
		const simple = simplifyTransaction(raw);

		expect(simple.date).toBe("2024-06-15");
	});

	test("handles date without timezone", () => {
		const raw = makeTxn({
			column0: { value: "2024-06-15", name: "Datum", id: 0 },
		});
		const simple = simplifyTransaction(raw);

		expect(simple.date).toBe("2024-06-15");
	});
});

describe("extractTransactions", () => {
	test("extracts transactions from response", () => {
		const txn1 = makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } });
		const txn2 = makeTxn({ column22: { value: 2, name: "ID pohybu", id: 22 } });
		const statement = makeStatement([txn1, txn2]);

		const transactions = extractTransactions(statement);

		expect(transactions).toHaveLength(2);
		expect(transactions[0]?.column22.value).toBe(1);
		expect(transactions[1]?.column22.value).toBe(2);
	});

	test("returns empty array when no transactions", () => {
		const statement = makeStatement([]);

		const transactions = extractTransactions(statement);

		expect(transactions).toEqual([]);
	});

	test("returns empty array when transaction is null", () => {
		const statement: FioAccountStatement = {
			accountStatement: {
				...makeStatement().accountStatement,
				transactionList: { transaction: null },
			},
		};

		const transactions = extractTransactions(statement);

		expect(transactions).toEqual([]);
	});
});

describe("sortTransactionsById", () => {
	test("sorts by ID ascending", () => {
		const transactions = [
			makeTxn({ column22: { value: 300, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 100, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 200, name: "ID pohybu", id: 22 } }),
		];

		const sorted = sortTransactionsById(transactions);

		expect(sorted[0]?.column22.value).toBe(100);
		expect(sorted[1]?.column22.value).toBe(200);
		expect(sorted[2]?.column22.value).toBe(300);
	});

	test("does not mutate original array", () => {
		const transactions = [
			makeTxn({ column22: { value: 200, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 100, name: "ID pohybu", id: 22 } }),
		];

		sortTransactionsById(transactions);

		expect(transactions[0]?.column22.value).toBe(200);
	});
});

describe("sortTransactionsByIdDesc", () => {
	test("sorts by ID descending (newest first)", () => {
		const transactions = [
			makeTxn({ column22: { value: 100, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 300, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 200, name: "ID pohybu", id: 22 } }),
		];

		const sorted = sortTransactionsByIdDesc(transactions);

		expect(sorted[0]?.column22.value).toBe(300);
		expect(sorted[1]?.column22.value).toBe(200);
		expect(sorted[2]?.column22.value).toBe(100);
	});
});

describe("deduplicateTransactions", () => {
	test("adds new transactions", () => {
		const existing = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
		];
		const incoming = [
			makeTxn({ column22: { value: 2, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 3, name: "ID pohybu", id: 22 } }),
		];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged).toHaveLength(3);
		expect(result.added).toBe(2);
		expect(result.duplicates).toBe(0);
	});

	test("skips duplicates", () => {
		const existing = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 2, name: "ID pohybu", id: 22 } }),
		];
		const incoming = [
			makeTxn({ column22: { value: 2, name: "ID pohybu", id: 22 } }), // duplicate
			makeTxn({ column22: { value: 3, name: "ID pohybu", id: 22 } }), // new
		];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged).toHaveLength(3);
		expect(result.added).toBe(1);
		expect(result.duplicates).toBe(1);
	});

	test("handles all duplicates", () => {
		const existing = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
		];
		const incoming = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
		];

		const result = deduplicateTransactions(existing, incoming);

		expect(result.merged).toHaveLength(1);
		expect(result.added).toBe(0);
		expect(result.duplicates).toBe(1);
	});

	test("handles empty existing", () => {
		const incoming = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
			makeTxn({ column22: { value: 2, name: "ID pohybu", id: 22 } }),
		];

		const result = deduplicateTransactions([], incoming);

		expect(result.merged).toHaveLength(2);
		expect(result.added).toBe(2);
		expect(result.duplicates).toBe(0);
	});

	test("handles empty incoming", () => {
		const existing = [
			makeTxn({ column22: { value: 1, name: "ID pohybu", id: 22 } }),
		];

		const result = deduplicateTransactions(existing, []);

		expect(result.merged).toHaveLength(1);
		expect(result.added).toBe(0);
		expect(result.duplicates).toBe(0);
	});
});

describe("detectCurrency", () => {
	test("returns currency from account info", () => {
		const statement = makeStatement([], "EUR");

		expect(detectCurrency(statement)).toBe("EUR");
	});

	test("returns CZK for Czech accounts", () => {
		const statement = makeStatement([], "CZK");

		expect(detectCurrency(statement)).toBe("CZK");
	});
});

describe("getAccountIban", () => {
	test("returns IBAN from account info", () => {
		const statement = makeStatement();

		expect(getAccountIban(statement)).toBe("CZ6520100000002900123456");
	});
});

describe("parseApiError", () => {
	test("returns rate limit error for 409", () => {
		const error = parseApiError(409, "");

		expect(error.message).toContain("Rate limited");
		expect(error.message).toContain("30 seconds");
	});

	test("returns API error for 500", () => {
		const error = parseApiError(500, "Internal server error");

		expect(error.message).toContain("Fio API error");
		expect(error.message).toContain("Internal server error");
	});

	test("returns token error for 404", () => {
		const error = parseApiError(404, "");

		expect(error.message).toContain("Token not found");
	});

	test("returns generic HTTP error for other codes", () => {
		const error = parseApiError(403, "Forbidden");

		expect(error.message).toBe("HTTP 403: Forbidden");
	});
});

describe("fetchTransactions", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("fetches transactions with date range", async () => {
		const mockResponse = makeStatement([makeTxn()]);
		const mockFn = mock((_url: string) =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		const result = await fetchTransactions("testtoken", {
			from: "2024-01-01",
			to: "2024-01-31",
		});

		expect(result.accountStatement.info.currency).toBe("CZK");
		expect(mockFn).toHaveBeenCalledTimes(1);
		expect(mockFn.mock.calls[0]?.[0]).toContain(
			"/periods/testtoken/2024-01-01/2024-01-31/",
		);
	});

	test("fetches transactions incrementally", async () => {
		const mockResponse = makeStatement([makeTxn()]);
		const mockFn = mock((_url: string) =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await fetchTransactions("testtoken", { incremental: true });

		expect(mockFn.mock.calls[0]?.[0]).toContain("/last/testtoken/");
	});

	test("throws on rate limit (409)", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 409,
				text: () => Promise.resolve("Rate limited"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactions("testtoken")).rejects.toThrow(
			"Rate limited",
		);
	});

	test("throws on invalid token (404)", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 404,
				text: () => Promise.resolve("Not found"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactions("testtoken")).rejects.toThrow(
			"Token not found",
		);
	});

	test("throws on server error (500)", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal error"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(fetchTransactions("testtoken")).rejects.toThrow(
			"Fio API error",
		);
	});
});

describe("setLastDownloadDate", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("calls correct URL", async () => {
		const mockFn = mock((_url: string) =>
			Promise.resolve({
				ok: true,
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await setLastDownloadDate("testtoken", "2024-01-15");

		expect(mockFn).toHaveBeenCalledTimes(1);
		expect(mockFn.mock.calls[0]?.[0]).toContain(
			"/set-last-date/testtoken/2024-01-15/",
		);
	});

	test("throws on error", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Error"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(
			setLastDownloadDate("testtoken", "2024-01-15"),
		).rejects.toThrow("Fio API error");
	});
});

describe("setLastDownloadId", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("calls correct URL", async () => {
		const mockFn = mock((_url: string) =>
			Promise.resolve({
				ok: true,
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await setLastDownloadId("testtoken", 12345);

		expect(mockFn).toHaveBeenCalledTimes(1);
		expect(mockFn.mock.calls[0]?.[0]).toContain(
			"/set-last-id/testtoken/12345/",
		);
	});

	test("throws on error", async () => {
		const mockFn = mock(() =>
			Promise.resolve({
				ok: false,
				status: 404,
				text: () => Promise.resolve("Not found"),
			} as Response),
		);
		globalThis.fetch = mockFn as unknown as typeof fetch;

		await expect(setLastDownloadId("testtoken", 12345)).rejects.toThrow(
			"Token not found",
		);
	});
});
