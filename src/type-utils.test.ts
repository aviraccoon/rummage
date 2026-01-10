/**
 * Type-level tests using @ts-expect-error.
 * These verify compile-time type safety, not runtime behavior.
 */

import { describe, expect, test } from "bun:test";
import type { LeafValues } from "./type-utils.ts";
import type { Override, Rule } from "./types.ts";

const C = {
	food: {
		groceries: "Expenses:Food:Groceries",
		delivery: "Expenses:Food:Delivery",
	},
	uncategorized: "Expenses:Uncategorized",
} as const;

type Category = LeafValues<typeof C>;

describe("LeafValues", () => {
	test("extracts leaf string values as union type", () => {
		// Type-level assertion: Category should be the union of all leaf values
		const valid: Category = "Expenses:Food:Groceries";
		expect(valid).toBe("Expenses:Food:Groceries");
	});

	test("rejects invalid category strings", () => {
		// @ts-expect-error - "Expenses:Typo" is not a valid Category
		const invalid: Category = "Expenses:Typo";
		// Type error above is the test - runtime value doesn't matter
		expect(typeof invalid).toBe("string");
	});
});

describe("Rule<Category>", () => {
	test("accepts valid categories", () => {
		const rule: Rule<Category> = {
			match: /TEST/,
			category: C.food.groceries,
		};
		expect(rule.category).toBe("Expenses:Food:Groceries");
	});

	test("rejects invalid categories", () => {
		const rule: Rule<Category> = {
			match: /TEST/,
			// @ts-expect-error - "Expenses:Invalid" is not a valid Category
			category: "Expenses:Invalid",
		};
		// Type error above is the test - runtime value doesn't matter
		expect(typeof rule.category).toBe("string");
	});

	test("allows undefined category", () => {
		const rule: Rule<Category> = {
			match: /TEST/,
			payee: "Test Payee",
			// category is optional
		};
		expect(rule.category).toBeUndefined();
	});
});

describe("Override<Category>", () => {
	test("accepts valid categories", () => {
		const override: Override<Category> = {
			id: "txn-123",
			category: C.food.groceries,
		};
		expect(override.category).toBe("Expenses:Food:Groceries");
	});

	test("rejects invalid categories", () => {
		const override: Override<Category> = {
			id: "txn-123",
			// @ts-expect-error - "Expenses:Invalid" is not a valid Category
			category: "Expenses:Invalid",
		};
		// Type error above is the test - runtime value doesn't matter
		expect(typeof override.category).toBe("string");
	});

	test("allows skip without category", () => {
		const override: Override<Category> = {
			id: "txn-123",
			skip: true,
		};
		expect(override.skip).toBe(true);
	});
});
