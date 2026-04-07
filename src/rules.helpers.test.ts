import { describe, expect, test } from "bun:test";
import { categorize } from "./rules.helpers.ts";

describe("categorize", () => {
	test("generates rules from pattern/payee pairs", () => {
		const rules = categorize("Expenses:Food", [
			[/PIZZA/i, "Pizza Place"],
			[/BURGER/i, "Burger Joint"],
		]);

		expect(rules).toHaveLength(2);
		expect(rules[0]).toEqual({
			match: /PIZZA/i,
			payee: "Pizza Place",
			category: "Expenses:Food",
		});
		expect(rules[1]).toEqual({
			match: /BURGER/i,
			payee: "Burger Joint",
			category: "Expenses:Food",
		});
	});

	test("handles patterns without payee", () => {
		const rules = categorize("Expenses:Food", [[/PIZZA/i]]);

		expect(rules[0]).toEqual({
			match: /PIZZA/i,
			payee: undefined,
			category: "Expenses:Food",
		});
	});

	test("passes recurring option to all rules", () => {
		const rules = categorize(
			"Expenses:Subs",
			[
				[/NETFLIX/i, "Netflix"],
				[/SPOTIFY/i, "Spotify"],
			],
			{ recurring: "monthly" },
		);

		expect(rules[0]?.recurring).toBe("monthly");
		expect(rules[1]?.recurring).toBe("monthly");
	});

	test("omits recurring when not specified", () => {
		const rules = categorize("Expenses:Food", [[/PIZZA/i]]);
		expect(rules[0]).not.toHaveProperty("recurring");
	});

	test("accepts array of patterns per entry", () => {
		const rules = categorize("Expenses:Food", [
			[[/MCDONALDS/i, /MCD /i], "McDonald's"],
		]);

		expect(rules).toHaveLength(1);
		expect(rules[0]?.match).toEqual([/MCDONALDS/i, /MCD /i]);
		expect(rules[0]?.payee).toBe("McDonald's");
	});
});
