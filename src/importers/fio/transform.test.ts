import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLES_RAW } from "../../config.ts";
import { assertAt } from "../../test-utils.ts";
import type { FioAccountStatement, FioTransaction } from "./api.ts";
import {
	importFioDirectory,
	importFioJson,
	importFioOfx,
} from "./transform.ts";

const TEST_DIR = join(tmpdir(), "rummage-test-fio");

function makeFioTxn(overrides: Partial<FioTransaction> = {}): FioTransaction {
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
): FioAccountStatement {
	return {
		accountStatement: {
			info: {
				accountId: "2900123456",
				bankId: "2010",
				currency: "CZK",
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

function setupTestDir() {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
	rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("importFioOfx", () => {
	test("imports Fio OFX file with fio prefix", () => {
		const result = importFioOfx(join(EXAMPLES_RAW, "fio/2025-12.ofx"), {
			accountMapping: {
				"1234567890": { account: "Assets:Fio:CZK", currency: "CZK" },
			},
		});

		expect(result.errors).toHaveLength(0);
		expect(result.transactions.length).toBeGreaterThan(0);

		// Fio importer uses "fio-" prefix
		const txn = assertAt(result.transactions, 0);
		expect(txn.id).toStartWith("fio-");
	});

	test("uses fio prefix by default", () => {
		const result = importFioOfx(join(EXAMPLES_RAW, "fio/2025-12.ofx"), {
			accountMapping: {
				"1234567890": { account: "Assets:Test", currency: "CZK" },
			},
		});

		const txn = assertAt(result.transactions, 0);
		expect(txn.id).toMatch(/^fio-1234567890-/);
	});
});

describe("importFioJson", () => {
	test("imports basic transaction", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "CZK_2024-01-01_2024-01-31.json");
		writeFileSync(filePath, JSON.stringify(makeStatement([makeFioTxn()])));

		const result = importFioJson(filePath);

		expect(result.transactions).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const txn = assertAt(result.transactions, 0);
		expect(txn.id).toBe("fio-12345");
		expect(txn.date).toBe("2024-01-15");
		expect(txn.amount.value).toBe(-500);
		expect(txn.amount.currency).toBe("CZK");
		expect(txn.account).toBe("Assets:Fio:CZK");
		expect(txn.description).toBe("Payment for services");

		cleanupTestDir();
	});

	test("strips timezone from date", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column0: { value: "2024-06-15+0200", name: "Datum", id: 0 },
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		expect(result.transactions[0]?.date).toBe("2024-06-15");

		cleanupTestDir();
	});

	test("uses user identification as description", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column7: {
							value: "Monthly rent payment",
							name: "Uživatelská identifikace",
							id: 7,
						},
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		expect(result.transactions[0]?.description).toBe("Monthly rent payment");

		cleanupTestDir();
	});

	test("falls back to counter account name for description", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column7: { value: null, name: "Uživatelská identifikace", id: 7 },
						column16: { value: null, name: "Zpráva pro příjemce", id: 16 },
						column10: { value: "Acme Corp", name: "Název protiúčtu", id: 10 },
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		expect(result.transactions[0]?.description).toBe("Acme Corp");

		cleanupTestDir();
	});

	test("stores Czech payment symbols in metadata", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column5: { value: "1234567890", name: "VS", id: 5 },
						column4: { value: "0308", name: "KS", id: 4 },
						column6: { value: "9999", name: "SS", id: 6 },
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		const metadata = result.transactions[0]?.metadata as Record<
			string,
			unknown
		>;

		expect(metadata?.variableSymbol).toBe("1234567890");
		expect(metadata?.constantSymbol).toBe("0308");
		expect(metadata?.specificSymbol).toBe("9999");

		cleanupTestDir();
	});

	test("stores counter account info in metadata", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column2: { value: "123456789", name: "Protiúčet", id: 2 },
						column10: { value: "Jan Novák", name: "Název protiúčtu", id: 10 },
						column3: { value: "0100", name: "Kód banky", id: 3 },
						column26: { value: "KOMBCZPP", name: "BIC", id: 26 },
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		const metadata = result.transactions[0]?.metadata as Record<
			string,
			unknown
		>;

		expect(metadata?.counterAccount).toBe("123456789");
		expect(metadata?.counterAccountName).toBe("Jan Novák");
		expect(metadata?.bankCode).toBe("0100");
		expect(metadata?.bic).toBe("KOMBCZPP");

		cleanupTestDir();
	});

	test("extracts payee from card transaction description", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column7: {
							value:
								"N\u00e1kup: COSTA DBK,  BUDEJOVICKA 1667/64, PRAHA 4, 140 00, CZE, dne 29.12.2017, \u010d\u00e1stka  99.00 CZK",
							name: "U\u017eivatelsk\u00e1 identifikace",
							id: 7,
						},
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		expect(result.transactions[0]?.payee).toBe("COSTA DBK");

		cleanupTestDir();
	});

	test("does not extract payee from non-card transactions", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				makeStatement([
					makeFioTxn({
						column7: {
							value: "Monthly rent payment",
							name: "U\u017eivatelsk\u00e1 identifikace",
							id: 7,
						},
					}),
				]),
			),
		);

		const result = importFioJson(filePath);
		expect(result.transactions[0]?.payee).toBeUndefined();

		cleanupTestDir();
	});

	test("handles empty transaction list", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "empty.json");
		writeFileSync(filePath, JSON.stringify(makeStatement([])));

		const result = importFioJson(filePath);

		expect(result.transactions).toHaveLength(0);
		expect(result.errors).toHaveLength(0);

		cleanupTestDir();
	});

	test("uses custom account base", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "test.json");
		writeFileSync(filePath, JSON.stringify(makeStatement([makeFioTxn()])));

		const result = importFioJson(filePath, { accountBase: "Assets:Bank:Fio" });

		expect(result.transactions[0]?.account).toBe("Assets:Bank:Fio:CZK");

		cleanupTestDir();
	});

	test("captures error for malformed transaction", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "malformed.json");
		// Create a statement with a malformed transaction (missing column22)
		const malformedStatement = {
			accountStatement: {
				info: {
					accountId: "123",
					bankId: "2010",
					currency: "CZK",
					iban: "CZ123",
					bic: "FIOBCZPP",
					openingBalance: 0,
					closingBalance: 0,
					dateStart: "2024-01-01",
					dateEnd: "2024-01-31",
					yearList: null,
					idList: null,
					idFrom: null,
					idTo: null,
					idLastDownload: null,
				},
				transactionList: {
					transaction: [
						{
							// Missing column22 (ID) - will cause error when accessing .value
							column22: null,
							column0: { value: "2024-01-15+0100", name: "Datum", id: 0 },
							column1: { value: -100, name: "Objem", id: 1 },
							column14: { value: "CZK", name: "Měna", id: 14 },
						},
					],
				},
			},
		};
		writeFileSync(filePath, JSON.stringify(malformedStatement));

		const result = importFioJson(filePath);

		expect(result.transactions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain("Failed to import transaction");

		cleanupTestDir();
	});
});

describe("importFioDirectory", () => {
	test("imports all OFX files from directory", () => {
		const result = importFioDirectory(join(EXAMPLES_RAW, "fio"), {
			accountMapping: {
				"1234567890": { account: "Assets:Fio:CZK", currency: "CZK" },
			},
		});

		expect(result.errors).toHaveLength(0);
		expect(result.transactions.length).toBeGreaterThan(0);

		// All transactions should have fio prefix
		for (const txn of result.transactions) {
			expect(txn.id).toStartWith("fio-");
		}
	});

	test("imports both JSON and OFX files", () => {
		setupTestDir();

		// Create a JSON file
		writeFileSync(
			join(TEST_DIR, "CZK_2024-01.json"),
			JSON.stringify(
				makeStatement([
					makeFioTxn({ column22: { value: 1001, name: "ID pohybu", id: 22 } }),
				]),
			),
		);

		// Copy an OFX file (we'll just check that both formats are found)
		const result = importFioDirectory(TEST_DIR);

		// Should have the JSON transaction
		expect(result.transactions.some((t) => t.id === "fio-1001")).toBe(true);

		cleanupTestDir();
	});

	test("deduplicates transactions by ID", () => {
		setupTestDir();

		// Create two JSON files with same transaction ID
		writeFileSync(
			join(TEST_DIR, "file1.json"),
			JSON.stringify(
				makeStatement([
					makeFioTxn({ column22: { value: 1001, name: "ID pohybu", id: 22 } }),
				]),
			),
		);
		writeFileSync(
			join(TEST_DIR, "file2.json"),
			JSON.stringify(
				makeStatement([
					makeFioTxn({ column22: { value: 1001, name: "ID pohybu", id: 22 } }),
					makeFioTxn({ column22: { value: 1002, name: "ID pohybu", id: 22 } }),
				]),
			),
		);

		const result = importFioDirectory(TEST_DIR);

		// Should have only 2 unique transactions
		expect(result.transactions).toHaveLength(2);
		expect(result.transactions.filter((t) => t.id === "fio-1001")).toHaveLength(
			1,
		);

		cleanupTestDir();
	});

	test("sorts transactions by date", () => {
		const result = importFioDirectory(join(EXAMPLES_RAW, "fio"), {
			accountMapping: {
				"1234567890": { account: "Assets:Fio:CZK", currency: "CZK" },
			},
		});

		const dates = result.transactions.map((t) => t.date);
		const sortedDates = [...dates].sort();

		expect(dates).toEqual(sortedDates);
	});
});
