import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildAccountDir,
	buildOutputFilename,
	discoverAccounts,
	filterAccounts,
	formatSampleTransaction,
} from "./fetch.ts";

describe("discoverAccounts", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Clear all FIO_TOKEN_* vars
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("FIO_TOKEN")) {
				delete process.env[key];
			}
		}
	});

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("FIO_TOKEN")) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	test("discovers single account", () => {
		process.env.FIO_TOKEN_PERSONAL = "token123";

		const accounts = discoverAccounts();

		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toEqual({ name: "personal", token: "token123" });
	});

	test("discovers multiple accounts", () => {
		process.env.FIO_TOKEN_PERSONAL = "token1";
		process.env.FIO_TOKEN_BUSINESS = "token2";
		process.env.FIO_TOKEN_SAVINGS = "token3";

		const accounts = discoverAccounts();

		expect(accounts).toHaveLength(3);
		expect(accounts.map((a) => a.name).sort()).toEqual([
			"business",
			"personal",
			"savings",
		]);
	});

	test("lowercases account names", () => {
		process.env.FIO_TOKEN_PERSONAL = "token1";
		process.env.FIO_TOKEN_MyBusiness = "token2";

		const accounts = discoverAccounts();

		expect(accounts.map((a) => a.name).sort()).toEqual([
			"mybusiness",
			"personal",
		]);
	});

	test("ignores empty tokens", () => {
		process.env.FIO_TOKEN_PERSONAL = "token1";
		process.env.FIO_TOKEN_EMPTY = "";

		const accounts = discoverAccounts();

		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.name).toBe("personal");
	});

	test("ignores FIO_TOKEN without suffix", () => {
		process.env.FIO_TOKEN = "oldstyletoken";
		process.env.FIO_TOKEN_NEW = "newstyletoken";

		const accounts = discoverAccounts();

		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.name).toBe("new");
	});

	test("returns empty array when no tokens", () => {
		const accounts = discoverAccounts();

		expect(accounts).toEqual([]);
	});

	test("handles multiple accounts with same currency", () => {
		process.env.FIO_TOKEN_CZK_PERSONAL = "token1";
		process.env.FIO_TOKEN_CZK_BUSINESS = "token2";

		const accounts = discoverAccounts();

		expect(accounts).toHaveLength(2);
		expect(accounts.map((a) => a.name).sort()).toEqual([
			"czk_business",
			"czk_personal",
		]);
	});
});

describe("filterAccounts", () => {
	const accounts = [
		{ name: "personal", token: "token1" },
		{ name: "business", token: "token2" },
		{ name: "savings", token: "token3" },
	];

	test("returns all accounts when no filter", () => {
		expect(filterAccounts(accounts, undefined)).toEqual(accounts);
	});

	test("filters by exact name match", () => {
		const result = filterAccounts(accounts, "personal");

		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("personal");
	});

	test("is case-insensitive", () => {
		const result = filterAccounts(accounts, "PERSONAL");

		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("personal");
	});

	test("returns empty array when no match", () => {
		const result = filterAccounts(accounts, "nonexistent");

		expect(result).toEqual([]);
	});

	test("handles empty accounts list", () => {
		expect(filterAccounts([], "personal")).toEqual([]);
	});
});

describe("buildOutputFilename", () => {
	test("builds filename with currency and dates", () => {
		const filename = buildOutputFilename("CZK", "2024-01-01", "2024-03-31");

		expect(filename).toBe("CZK_2024-01-01_2024-03-31.json");
	});

	test("handles EUR currency", () => {
		const filename = buildOutputFilename("EUR", "2024-06-01", "2024-06-30");

		expect(filename).toBe("EUR_2024-06-01_2024-06-30.json");
	});
});

describe("buildAccountDir", () => {
	test("builds fio-{name} directory in raw dir", () => {
		const dir = buildAccountDir("/data/raw", "personal");

		expect(dir).toBe("/data/raw/fio-personal");
	});

	test("handles business account", () => {
		const dir = buildAccountDir("/home/user/rummage/data/raw", "business");

		expect(dir).toBe("/home/user/rummage/data/raw/fio-business");
	});
});

describe("formatSampleTransaction", () => {
	test("formats positive amount with plus sign", () => {
		const result = formatSampleTransaction({
			date: "2024-01-15",
			amount: 1000,
			currency: "CZK",
			userIdentification: "Salary payment",
			type: "Příchozí platba",
		});

		expect(result).toBe("2024-01-15 +1000 CZK - Salary payment");
	});

	test("formats negative amount without sign", () => {
		const result = formatSampleTransaction({
			date: "2024-01-20",
			amount: -500,
			currency: "CZK",
			userIdentification: "Grocery store",
			type: "Odchozí platba",
		});

		expect(result).toBe("2024-01-20 -500 CZK - Grocery store");
	});

	test("uses type when userIdentification is null", () => {
		const result = formatSampleTransaction({
			date: "2024-01-25",
			amount: -100,
			currency: "EUR",
			userIdentification: null,
			type: "Card payment",
		});

		expect(result).toBe("2024-01-25 -100 EUR - Card payment");
	});

	test("handles zero amount", () => {
		const result = formatSampleTransaction({
			date: "2024-02-01",
			amount: 0,
			currency: "CZK",
			userIdentification: "Fee reversal",
			type: "Storno",
		});

		expect(result).toBe("2024-02-01 0 CZK - Fee reversal");
	});
});
