import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXAMPLES_PATH, EXAMPLES_RAW } from "./config.ts";
import {
	applyOverrides,
	getOverrideFilePath,
	loadAllOverrides,
	loadOverrides,
} from "./overrides.ts";
import type { Override, Transaction } from "./types.ts";

function makeTxn(id: string, category?: string): Transaction {
	return {
		id,
		date: "2025-12-01",
		amount: { value: -100, currency: "CZK" },
		description: "Test transaction",
		account: "Assets:Test",
		source: "test.ofx",
		category,
	};
}

describe("applyOverrides", () => {
	test("applies category override", () => {
		const transactions = [makeTxn("txn-1", "Expenses:Old")];
		const overrides: Override[] = [{ id: "txn-1", category: "Expenses:New" }];

		const result = applyOverrides(transactions, overrides);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]?.category).toBe("Expenses:New");
		expect(result.applied).toBe(1);
		expect(result.skipped).toBe(0);
	});

	test("applies payee override", () => {
		const transactions = [makeTxn("txn-1")];
		const overrides: Override[] = [{ id: "txn-1", payee: "New Payee" }];

		const result = applyOverrides(transactions, overrides);

		expect(result.transactions[0]?.payee).toBe("New Payee");
	});

	test("applies memo override", () => {
		const transactions = [makeTxn("txn-1")];
		const overrides: Override[] = [{ id: "txn-1", memo: "New memo" }];

		const result = applyOverrides(transactions, overrides);

		expect(result.transactions[0]?.memo).toBe("New memo");
	});

	test("merges tags instead of replacing", () => {
		const transactions: Transaction[] = [
			{ ...makeTxn("txn-1"), tags: ["existing"] },
		];
		const overrides: Override[] = [{ id: "txn-1", tags: ["new-tag"] }];

		const result = applyOverrides(transactions, overrides);

		expect(result.transactions[0]?.tags).toEqual(["existing", "new-tag"]);
	});

	test("skips transaction when skip: true", () => {
		const transactions = [makeTxn("txn-1"), makeTxn("txn-2")];
		const overrides: Override[] = [{ id: "txn-1", skip: true }];

		const result = applyOverrides(transactions, overrides);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]?.id).toBe("txn-2");
		expect(result.skipped).toBe(1);
	});

	test("reports unmatched override IDs", () => {
		const transactions = [makeTxn("txn-1")];
		const overrides: Override[] = [
			{ id: "txn-1", category: "Expenses:New" },
			{ id: "txn-missing", category: "Expenses:Other" },
		];

		const result = applyOverrides(transactions, overrides);

		expect(result.unmatched).toEqual(["txn-missing"]);
	});

	test("handles empty overrides", () => {
		const transactions = [makeTxn("txn-1"), makeTxn("txn-2")];

		const result = applyOverrides(transactions, []);

		expect(result.transactions).toHaveLength(2);
		expect(result.applied).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.unmatched).toEqual([]);
	});

	test("handles empty transactions", () => {
		const overrides: Override[] = [{ id: "txn-1", skip: true }];

		const result = applyOverrides([], overrides);

		expect(result.transactions).toHaveLength(0);
		expect(result.unmatched).toEqual(["txn-1"]);
	});

	test("applies multiple fields in single override", () => {
		const transactions = [makeTxn("txn-1", "Expenses:Old")];
		const overrides: Override[] = [
			{
				id: "txn-1",
				category: "Expenses:New",
				payee: "New Payee",
				memo: "New memo",
				tags: ["tagged"],
			},
		];

		const result = applyOverrides(transactions, overrides);

		const txn = result.transactions[0];
		expect(txn?.category).toBe("Expenses:New");
		expect(txn?.payee).toBe("New Payee");
		expect(txn?.memo).toBe("New memo");
		expect(txn?.tags).toEqual(["tagged"]);
	});
});

describe("getOverrideFilePath", () => {
	test("returns null for non-existent override file", () => {
		const result = getOverrideFilePath("/non/existent/file.ofx");
		expect(result).toBeNull();
	});

	test("returns path when override file exists", () => {
		const result = getOverrideFilePath(join(EXAMPLES_RAW, "fio/2025-12.ofx"));
		expect(result).toBe(join(EXAMPLES_RAW, "fio/2025-12.overrides.ts"));
	});
});

describe("loadOverrides", () => {
	test("returns empty array for non-existent file", async () => {
		const result = await loadOverrides("/non/existent/overrides.ts");
		expect(result).toEqual([]);
	});

	test("loads overrides from existing file", async () => {
		const result = await loadOverrides(join(EXAMPLES_PATH, "overrides.ts"));
		expect(result.length).toBeGreaterThan(0);
		expect(result[0]?.id).toBe("fio-1234567890-10007");
	});
});

describe("loadAllOverrides", () => {
	test("returns empty array when no override files exist", async () => {
		const result = await loadAllOverrides("/non/existent/path", []);
		expect(result).toEqual([]);
	});

	test("loads global overrides from data path", async () => {
		const result = await loadAllOverrides(EXAMPLES_PATH, []);
		expect(result.length).toBeGreaterThan(0);
	});

	test("handles missing per-file overrides gracefully", async () => {
		const result = await loadAllOverrides(EXAMPLES_PATH, [
			"/non/existent/file.ofx", // No .overrides.ts exists for this
		]);
		// Should still have global overrides, no error from missing per-file
		expect(result.length).toBeGreaterThan(0);
	});

	test("loads per-file overrides when they exist", async () => {
		const result = await loadAllOverrides(EXAMPLES_PATH, [
			join(EXAMPLES_RAW, "fio/2025-12.ofx"),
		]);
		// Should have global + per-file overrides
		expect(result.length).toBeGreaterThan(1);
		// Check per-file override is included
		const perFileOverride = result.find((o) => o.id === "fio-1234567890-10009");
		expect(perFileOverride).toBeDefined();
		expect(perFileOverride?.memo).toBe("Per-file override test");
	});
});
