import { describe, expect, test } from "bun:test";
import { applyRules, ruleMatches } from "./rules.ts";
import type { Rule, Transaction } from "./types.ts";

function makeTxn(overrides: Partial<Transaction> = {}): Transaction {
	return {
		id: "test-1",
		date: "2024-01-15",
		amount: { value: -100, currency: "CZK" },
		description: "Test transaction",
		account: "Assets:Test",
		source: "test.json",
		...overrides,
	};
}

describe("ruleMatches", () => {
	describe("match (description/name/memo)", () => {
		test("matches description", () => {
			const rule: Rule = { match: /Spotify/, category: "Expenses:Music" };
			const txn = makeTxn({ description: "Spotify Premium" });

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("matches rawName", () => {
			const rule: Rule = { match: /SPOTIFY/, category: "Expenses:Music" };
			const txn = makeTxn({
				description: "Card payment",
				rawName: "SPOTIFY AB",
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("matches rawMemo", () => {
			const rule: Rule = { match: /subscription/, category: "Expenses:Subs" };
			const txn = makeTxn({
				description: "Payment",
				rawMemo: "Monthly subscription",
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("returns false when no match", () => {
			const rule: Rule = { match: /Netflix/, category: "Expenses:Subs" };
			const txn = makeTxn({ description: "Spotify" });

			expect(ruleMatches(rule, txn)).toBe(false);
		});
	});

	describe("matchName", () => {
		test("matches only rawName", () => {
			const rule: Rule = { matchName: /ACME/, category: "Expenses:Test" };
			const txn = makeTxn({ rawName: "ACME Corp" });

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("ignores description when using matchName", () => {
			const rule: Rule = { matchName: /ACME/, category: "Expenses:Test" };
			const txn = makeTxn({ description: "ACME Corp", rawName: "Other" });

			expect(ruleMatches(rule, txn)).toBe(false);
		});

		test("returns false when rawName is missing", () => {
			const rule: Rule = { matchName: /ACME/, category: "Expenses:Test" };
			const txn = makeTxn({ description: "ACME Corp" });

			expect(ruleMatches(rule, txn)).toBe(false);
		});
	});

	describe("matchMemo", () => {
		test("matches only rawMemo", () => {
			const rule: Rule = { matchMemo: /rent/, category: "Expenses:Housing" };
			const txn = makeTxn({ rawMemo: "Monthly rent payment" });

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("returns false when rawMemo is missing", () => {
			const rule: Rule = { matchMemo: /rent/, category: "Expenses:Housing" };
			const txn = makeTxn({ description: "Rent" });

			expect(ruleMatches(rule, txn)).toBe(false);
		});
	});

	describe("matchMetadata", () => {
		test("matches single metadata field", () => {
			const rule: Rule = {
				matchMetadata: { variableSymbol: /^1234/ },
				category: "Expenses:Rent",
			};
			const txn = makeTxn({
				metadata: { variableSymbol: "1234567890" },
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("matches multiple metadata fields (all must match)", () => {
			const rule: Rule = {
				matchMetadata: {
					variableSymbol: /^1234/,
					counterAccount: /^CZ/,
				},
				category: "Expenses:Rent",
			};
			const txn = makeTxn({
				metadata: {
					variableSymbol: "1234567890",
					counterAccount: "CZ1234567890",
				},
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("returns false when one metadata field doesn't match", () => {
			const rule: Rule = {
				matchMetadata: {
					variableSymbol: /^1234/,
					counterAccount: /^SK/,
				},
				category: "Expenses:Rent",
			};
			const txn = makeTxn({
				metadata: {
					variableSymbol: "1234567890",
					counterAccount: "CZ1234567890",
				},
			});

			expect(ruleMatches(rule, txn)).toBe(false);
		});

		test("returns false when metadata is missing", () => {
			const rule: Rule = {
				matchMetadata: { variableSymbol: /^1234/ },
				category: "Expenses:Rent",
			};
			const txn = makeTxn();

			expect(ruleMatches(rule, txn)).toBe(false);
		});

		test("returns false when metadata field is null", () => {
			const rule: Rule = {
				matchMetadata: { variableSymbol: /^1234/ },
				category: "Expenses:Rent",
			};
			const txn = makeTxn({
				metadata: { variableSymbol: null },
			});

			expect(ruleMatches(rule, txn)).toBe(false);
		});

		test("converts numbers to string for matching", () => {
			const rule: Rule = {
				matchMetadata: { fioId: /^12345/ },
				category: "Expenses:Test",
			};
			const txn = makeTxn({
				metadata: { fioId: 12345678 },
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});
	});

	describe("matchFn", () => {
		test("calls custom function", () => {
			const rule: Rule = {
				matchFn: (txn) => txn.amount.value < -500,
				category: "Expenses:Large",
			};

			expect(
				ruleMatches(
					rule,
					makeTxn({ amount: { value: -1000, currency: "CZK" } }),
				),
			).toBe(true);
			expect(
				ruleMatches(
					rule,
					makeTxn({ amount: { value: -100, currency: "CZK" } }),
				),
			).toBe(false);
		});

		test("can access metadata", () => {
			const rule: Rule = {
				matchFn: (txn) => txn.metadata?.revolutType === "TOPUP",
				category: "Income:Topup",
			};
			const txn = makeTxn({
				metadata: { revolutType: "TOPUP" },
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});

		test("complex condition with amount and metadata", () => {
			const rule: Rule = {
				matchFn: (txn) =>
					txn.amount.value > 0 &&
					txn.metadata?.counterAccountName === "Employer Inc",
				category: "Income:Salary",
			};
			const txn = makeTxn({
				amount: { value: 50000, currency: "CZK" },
				metadata: { counterAccountName: "Employer Inc" },
			});

			expect(ruleMatches(rule, txn)).toBe(true);
		});
	});

	describe("combined matchers", () => {
		test("all matchers must pass", () => {
			const rule: Rule = {
				match: /Payment/,
				matchMetadata: { variableSymbol: /^1234/ },
				category: "Expenses:Rent",
			};

			// Both match
			expect(
				ruleMatches(
					rule,
					makeTxn({
						description: "Payment for rent",
						metadata: { variableSymbol: "1234567890" },
					}),
				),
			).toBe(true);

			// Only description matches
			expect(
				ruleMatches(
					rule,
					makeTxn({
						description: "Payment for rent",
						metadata: { variableSymbol: "9999" },
					}),
				),
			).toBe(false);

			// Only metadata matches
			expect(
				ruleMatches(
					rule,
					makeTxn({
						description: "Other thing",
						metadata: { variableSymbol: "1234567890" },
					}),
				),
			).toBe(false);
		});

		test("matchFn can override pattern matchers", () => {
			const rule: Rule = {
				match: /Spotify/,
				matchFn: (txn) => txn.amount.value < -50,
				category: "Expenses:Music",
			};

			// Both match
			expect(
				ruleMatches(
					rule,
					makeTxn({
						description: "Spotify",
						amount: { value: -100, currency: "CZK" },
					}),
				),
			).toBe(true);

			// Pattern matches but function doesn't
			expect(
				ruleMatches(
					rule,
					makeTxn({
						description: "Spotify",
						amount: { value: -10, currency: "CZK" },
					}),
				),
			).toBe(false);
		});
	});

	describe("empty rule", () => {
		test("returns false for rule with no matchers", () => {
			const rule: Rule = { category: "Expenses:Test" };
			const txn = makeTxn();

			expect(ruleMatches(rule, txn)).toBe(false);
		});
	});
});

describe("applyRules", () => {
	test("applies first matching rule", () => {
		const rules: Rule[] = [
			{ match: /Spotify/, category: "Expenses:Music", payee: "Spotify" },
			{
				match: /Netflix/,
				category: "Expenses:Entertainment",
				payee: "Netflix",
			},
		];
		const transactions = [
			makeTxn({ id: "1", description: "Spotify Premium" }),
			makeTxn({ id: "2", description: "Netflix Monthly" }),
		];

		const result = applyRules(transactions, rules);

		expect(result[0]?.category).toBe("Expenses:Music");
		expect(result[0]?.payee).toBe("Spotify");
		expect(result[1]?.category).toBe("Expenses:Entertainment");
		expect(result[1]?.payee).toBe("Netflix");
	});

	test("skips already categorized transactions", () => {
		const rules: Rule[] = [{ match: /Spotify/, category: "Expenses:Music" }];
		const transactions = [
			makeTxn({ description: "Spotify", category: "Expenses:Override" }),
		];

		const result = applyRules(transactions, rules);

		expect(result[0]?.category).toBe("Expenses:Override");
	});

	test("adds recurring tag when specified", () => {
		const rules: Rule[] = [
			{ match: /Rent/, category: "Expenses:Rent", recurring: "monthly" },
		];
		const transactions = [makeTxn({ description: "Rent payment" })];

		const result = applyRules(transactions, rules);

		expect(result[0]?.tags).toContain("recurring");
		expect(result[0]?.tags).toContain("monthly");
	});

	test("preserves existing payee if rule doesn't specify one", () => {
		const rules: Rule[] = [{ match: /Payment/, category: "Expenses:Test" }];
		const transactions = [
			makeTxn({ description: "Payment", payee: "Original Payee" }),
		];

		const result = applyRules(transactions, rules);

		expect(result[0]?.payee).toBe("Original Payee");
	});

	test("leaves uncategorized if no rule matches", () => {
		const rules: Rule[] = [
			{ match: /Netflix/, category: "Expenses:Entertainment" },
		];
		const transactions = [makeTxn({ description: "Random purchase" })];

		const result = applyRules(transactions, rules);

		expect(result[0]?.category).toBeUndefined();
	});
});
