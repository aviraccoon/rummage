import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RevolutTransaction } from "./api.ts";
import {
	importRevolutDirectory,
	importRevolutFile,
	sanitizeCurrency,
} from "./transform.ts";

const TEST_DIR = join(tmpdir(), "rummage-test-revolut");

function makeRevolutTxn(
	overrides: Partial<RevolutTransaction> = {},
): RevolutTransaction {
	return {
		id: "test-id",
		legId: "test-leg-id",
		type: "CARD_PAYMENT",
		state: "COMPLETED",
		startedDate: 1704067200000, // 2024-01-01 00:00:00 UTC
		currency: "USD",
		amount: -1234,
		description: "Test merchant",
		category: "shopping",
		...overrides,
	};
}

function setupTestDir() {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
	rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("sanitizeCurrency", () => {
	test("passes through normal fiat currencies", () => {
		expect(sanitizeCurrency("USD")).toBe("USD");
		expect(sanitizeCurrency("EUR")).toBe("EUR");
		expect(sanitizeCurrency("CZK")).toBe("CZK");
	});

	test("passes through simple crypto codes", () => {
		expect(sanitizeCurrency("BTC")).toBe("BTC");
		expect(sanitizeCurrency("DOT")).toBe("DOT");
		expect(sanitizeCurrency("BCH")).toBe("BCH");
	});

	test("strips colons and digits from Revolut crypto codes", () => {
		expect(sanitizeCurrency("X:8:SUI")).toBe("XSUI");
	});

	test("uppercases lowercase input", () => {
		expect(sanitizeCurrency("usd")).toBe("USD");
		expect(sanitizeCurrency("x:8:sui")).toBe("XSUI");
	});

	test("throws on empty result", () => {
		expect(() => sanitizeCurrency("123")).toThrow();
		expect(() => sanitizeCurrency("::")).toThrow();
	});
});

describe("importRevolutFile", () => {
	test("imports basic transaction", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(filePath, JSON.stringify([makeRevolutTxn()]));

		const result = importRevolutFile(filePath);

		expect(result.transactions).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const txn = result.transactions[0];
		expect(txn?.id).toBe("revolut-test-leg-id");
		expect(txn?.date).toBe("2024-01-01");
		expect(txn?.amount.value).toBe(-12.34);
		expect(txn?.amount.currency).toBe("USD");
		expect(txn?.account).toBe("Assets:Revolut:USD");
		expect(txn?.description).toBe("Test merchant");
		expect(txn?.category).toBe("Expenses:Shopping");

		cleanupTestDir();
	});

	test("uses merchant name over description", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					description: "Generic description",
					merchant: {
						name: "Actual Merchant Name",
						city: "Prague",
						country: "CZ",
					},
				}),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.description).toBe("Actual Merchant Name");
		expect(result.transactions[0]?.location?.name).toBe("Prague, CZ");

		cleanupTestDir();
	});

	test("handles currency conversion with counterpart", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					amount: -500,
					currency: "USD",
					counterpart: {
						amount: -10000,
						currency: "CZK",
					},
				}),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.amount.value).toBe(-5);
		expect(result.transactions[0]?.amount.currency).toBe("USD");
		expect(result.transactions[0]?.originalAmount?.value).toBe(-100);
		expect(result.transactions[0]?.originalAmount?.currency).toBe("CZK");

		cleanupTestDir();
	});

	test("includes pending transactions with pending flag", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({ state: "PENDING", legId: "pending-1" }),
				makeRevolutTxn({ state: "COMPLETED", legId: "completed-1" }),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions).toHaveLength(2);
		const pending = result.transactions.find(
			(t) => t.id === "revolut-pending-1",
		);
		const completed = result.transactions.find(
			(t) => t.id === "revolut-completed-1",
		);
		expect(pending?.pending).toBe(true);
		expect(completed?.pending).toBeUndefined();

		cleanupTestDir();
	});

	test("skips cancelled/failed/reverted transactions", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({ state: "CANCELLED", legId: "cancelled-1" }),
				makeRevolutTxn({ state: "FAILED", legId: "failed-1" }),
				makeRevolutTxn({ state: "REVERTED", legId: "reverted-1" }),
				makeRevolutTxn({ state: "DECLINED", legId: "declined-1" }),
				makeRevolutTxn({ state: "COMPLETED", legId: "completed-1" }),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]?.id).toBe("revolut-completed-1");

		cleanupTestDir();
	});

	test("maps categories to expense paths", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({ category: "groceries", legId: "1" }),
				makeRevolutTxn({ category: "restaurants", legId: "2" }),
				makeRevolutTxn({ category: "transport", legId: "3" }),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.category).toBe("Expenses:Food:Groceries");
		expect(result.transactions[1]?.category).toBe("Expenses:Food:Restaurants");
		expect(result.transactions[2]?.category).toBe("Expenses:Transport");

		cleanupTestDir();
	});

	test("adds tags for special transaction types", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({ type: "TOPUP", legId: "1" }),
				makeRevolutTxn({ type: "TRANSFER", legId: "2" }),
				makeRevolutTxn({ type: "CARD_PAYMENT", legId: "3" }),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.tags).toContain("topup");
		expect(result.transactions[1]?.tags).toContain("transfer");
		expect(result.transactions[2]?.tags).toBeUndefined();

		cleanupTestDir();
	});

	test("adds tag when different from category", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					legId: "tag-test",
					category: "shopping",
					tag: "gifts",
				}),
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.tags).toContain("gifts");

		cleanupTestDir();
	});

	test("handles exchange transaction - outgoing leg", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "EUR_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				{
					id: "exchange-001",
					legId: "exchange-001-0000",
					type: "EXCHANGE",
					state: "COMPLETED",
					startedDate: 1704067200000,
					currency: "EUR",
					amount: -5000, // -50.00 EUR (outgoing)
					description: "Exchanged to CZK",
					category: "general",
					direction: "sell",
					counterpart: {
						amount: 125000, // 1250.00 CZK (incoming)
						currency: "CZK",
					},
				},
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions).toHaveLength(1);
		const txn = result.transactions[0];
		expect(txn?.id).toBe("revolut-exchange-001-0000");
		expect(txn?.amount.value).toBe(-50);
		expect(txn?.amount.currency).toBe("EUR");
		expect(txn?.account).toBe("Assets:Revolut:EUR");
		expect(txn?.transfer).toBeDefined();
		expect(txn?.transfer?.toAccount).toBe("Assets:Revolut:CZK");
		expect(txn?.transfer?.toAmount.value).toBe(1250);
		expect(txn?.transfer?.toAmount.currency).toBe("CZK");
		// Exchanges should not have a category (they're transfers, not expenses)
		expect(txn?.category).toBeUndefined();

		cleanupTestDir();
	});

	test("skips exchange transaction - receiving leg", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "CZK_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				{
					id: "exchange-001",
					legId: "exchange-001-0001",
					type: "EXCHANGE",
					state: "COMPLETED",
					startedDate: 1704067200000,
					currency: "CZK",
					amount: 125000, // 1250.00 CZK (incoming - should be skipped)
					description: "Exchanged from EUR",
					category: "general",
					direction: "buy",
					counterpart: {
						amount: -5000,
						currency: "EUR",
					},
				},
			]),
		);

		const result = importRevolutFile(filePath);

		// Receiving leg should be skipped
		expect(result.transactions).toHaveLength(0);

		cleanupTestDir();
	});

	test("captures error for malformed transaction", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		// Transaction with undefined startedDate will cause epochToDate to fail
		writeFileSync(
			filePath,
			JSON.stringify([
				{
					id: "bad-txn",
					legId: "bad-leg",
					type: "CARD_PAYMENT",
					state: "COMPLETED",
					startedDate: undefined,
					currency: "USD",
					amount: -100,
					description: "Bad txn",
				},
			]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain("Failed to import transaction");

		cleanupTestDir();
	});

	test("stores rich metadata", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "USD_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					merchant: {
						name: "Test Shop",
						mcc: "5411",
						category: "groceries",
						city: "Prague",
						country: "CZ",
						address: "123 Main St",
					},
					rate: 23.5,
					fee: 100,
					countryCode: "CZ",
				}),
			]),
		);

		const result = importRevolutFile(filePath);
		const metadata = result.transactions[0]?.metadata as Record<
			string,
			unknown
		>;
		const merchant = metadata?.merchant as Record<string, unknown> | undefined;

		expect(metadata?.revolutType).toBe("CARD_PAYMENT");
		expect(metadata?.revolutState).toBe("COMPLETED");
		expect(merchant?.mcc).toBe("5411");
		expect(metadata?.rate).toBe(23.5);
		expect(metadata?.fee).toBe(1);
		expect(metadata?.countryCode).toBe("CZ");

		cleanupTestDir();
	});

	test("detects currency from filename", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "EUR_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([makeRevolutTxn({ currency: "EUR" })]),
		);

		const result = importRevolutFile(filePath);

		expect(result.transactions[0]?.account).toBe("Assets:Revolut:EUR");

		cleanupTestDir();
	});

	test("sanitizes non-standard crypto currency codes", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "CZK_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					legId: "crypto-sell",
					currency: "X:9:FAKECOIN",
					amount: -500000,
					type: "EXCHANGE",
					rate: 5.5,
					counterpart: { amount: 2750, currency: "CZK" },
					balance: 0,
				}),
			]),
		);

		const result = importRevolutFile(filePath);

		// Transaction should use sanitized currency
		const txn = result.transactions[0];
		expect(txn?.amount.currency).toBe("XFAKECOIN");
		expect(txn?.account).toBe("Assets:Revolut:XFAKECOIN");

		// Transfer destination should also be sanitized
		expect(txn?.transfer?.toAmount.currency).toBe("CZK");
		expect(txn?.transfer?.toAccount).toBe("Assets:Revolut:CZK");

		// Balance assertion should use sanitized currency
		const assertion = result.balanceAssertions?.[0];
		expect(assertion?.account).toBe("Assets:Revolut:XFAKECOIN");
		expect(assertion?.balance.currency).toBe("XFAKECOIN");

		// Price directive should use sanitized currencies
		const price = result.prices?.[0];
		expect(price?.baseCurrency).toBe("XFAKECOIN");
		expect(price?.quoteCurrency).toBe("CZK");

		cleanupTestDir();
	});

	test("passes through standard crypto codes unchanged", () => {
		setupTestDir();
		const filePath = join(TEST_DIR, "BTC_2024.json");
		writeFileSync(
			filePath,
			JSON.stringify([
				makeRevolutTxn({
					legId: "btc-sell",
					currency: "BTC",
					amount: -10000000,
					type: "EXCHANGE",
					rate: 50000,
					counterpart: { amount: 5000000, currency: "USD" },
					balance: 0,
				}),
			]),
		);

		const result = importRevolutFile(filePath);

		const txn = result.transactions[0];
		expect(txn?.amount.currency).toBe("BTC");
		expect(txn?.account).toBe("Assets:Revolut:BTC");

		cleanupTestDir();
	});
});

describe("importRevolutDirectory", () => {
	test("imports multiple files", () => {
		setupTestDir();
		writeFileSync(
			join(TEST_DIR, "USD_2024.json"),
			JSON.stringify([
				makeRevolutTxn({ legId: "usd-1", startedDate: 1704067200000 }),
			]),
		);
		writeFileSync(
			join(TEST_DIR, "EUR_2024.json"),
			JSON.stringify([
				makeRevolutTxn({
					legId: "eur-1",
					currency: "EUR",
					startedDate: 1704153600000,
				}),
			]),
		);

		const result = importRevolutDirectory(TEST_DIR);

		expect(result.transactions).toHaveLength(2);
		expect(result.transactions[0]?.id).toBe("revolut-usd-1");
		expect(result.transactions[1]?.id).toBe("revolut-eur-1");

		cleanupTestDir();
	});

	test("ignores non-matching files", () => {
		setupTestDir();
		writeFileSync(
			join(TEST_DIR, "USD_2024.json"),
			JSON.stringify([makeRevolutTxn()]),
		);
		// These don't match the {CUR}_{YEAR}.json pattern
		writeFileSync(
			join(TEST_DIR, "backup.json"),
			JSON.stringify([makeRevolutTxn({ legId: "backup" })]),
		);
		writeFileSync(join(TEST_DIR, "random.json"), JSON.stringify([]));

		const result = importRevolutDirectory(TEST_DIR);

		expect(result.transactions).toHaveLength(1);

		cleanupTestDir();
	});

	test("sorts transactions by date", () => {
		setupTestDir();
		writeFileSync(
			join(TEST_DIR, "USD_2024.json"),
			JSON.stringify([
				makeRevolutTxn({ legId: "later", startedDate: 1704153600000 }), // 2024-01-02
				makeRevolutTxn({ legId: "earlier", startedDate: 1704067200000 }), // 2024-01-01
			]),
		);

		const result = importRevolutDirectory(TEST_DIR);

		expect(result.transactions[0]?.id).toBe("revolut-earlier");
		expect(result.transactions[1]?.id).toBe("revolut-later");

		cleanupTestDir();
	});

	test("calculates opening balances per currency across all files", () => {
		setupTestDir();

		// EUR file has an exchange TO CZK (EUR is sold, CZK is received)
		// This means CZK transactions appear in EUR file
		writeFileSync(
			join(TEST_DIR, "EUR_2024.json"),
			JSON.stringify([
				// Exchange outgoing leg (EUR sold)
				makeRevolutTxn({
					legId: "eur-exchange-out",
					type: "EXCHANGE",
					currency: "EUR",
					amount: -5000, // -50 EUR
					balance: 0,
					startedDate: 1704067200000, // 2024-01-01
					counterpart: { amount: 125000, currency: "CZK" },
				}),
				// Exchange receiving leg (CZK received) - this is in EUR file!
				makeRevolutTxn({
					legId: "czk-exchange-in",
					type: "EXCHANGE",
					currency: "CZK",
					amount: 125000, // +1250 CZK
					balance: 125000, // 1250 CZK after
					startedDate: 1704067200000,
				}),
			]),
		);

		// CZK file has later transactions
		writeFileSync(
			join(TEST_DIR, "CZK_2024.json"),
			JSON.stringify([
				makeRevolutTxn({
					legId: "czk-spend",
					currency: "CZK",
					amount: -50000, // -500 CZK
					balance: 75000, // 750 CZK after
					startedDate: 1704153600000, // 2024-01-02
				}),
			]),
		);

		const result = importRevolutDirectory(TEST_DIR);

		// Should have opening balances for both EUR and CZK
		expect(result.openingBalances).toBeDefined();
		expect(result.openingBalances).toHaveLength(2);

		// EUR opening: balance(0) - amount(-5000) = 5000 = 50 EUR
		const eurOpening = result.openingBalances?.find((o) =>
			o.account.endsWith(":EUR"),
		);
		expect(eurOpening?.balance.value).toBe(50);

		// CZK opening: balance(125000) - amount(125000) = 0 CZK
		// (CZK started at 0, first transaction added 1250)
		const czkOpening = result.openingBalances?.find((o) =>
			o.account.endsWith(":CZK"),
		);
		expect(czkOpening?.balance.value).toBe(0);

		// Balance assertions should be from latest transaction per currency
		expect(result.balanceAssertions).toBeDefined();
		expect(result.balanceAssertions).toHaveLength(2);

		// EUR assertion: 0 EUR (after the exchange)
		const eurAssertion = result.balanceAssertions?.find((a) =>
			a.account.endsWith(":EUR"),
		);
		expect(eurAssertion?.balance.value).toBe(0);

		// CZK assertion: 750 CZK (after the spend)
		const czkAssertion = result.balanceAssertions?.find((a) =>
			a.account.endsWith(":CZK"),
		);
		expect(czkAssertion?.balance.value).toBe(750);

		cleanupTestDir();
	});
});
