/**
 * Helpers for building categorization rules.
 * Use these in your data directory's rules.ts to reduce boilerplate.
 */

import type { Rule } from "./types.ts";

type Pattern = RegExp | RegExp[];

/**
 * Generate rules from [pattern, payee?] pairs sharing a category.
 * Pattern can be a single RegExp or an array of RegExp (any match = pass).
 *
 * @example
 * ...categorize("Expenses:Food:Restaurants", [
 *   [/PIZZA HUT/i, "Pizza Hut"],
 *   [[/MCDONALDS/i, /MCD /i], "McDonald's"],  // multiple patterns, one payee
 *   [/BURGER KING/i],  // no payee normalization
 * ])
 */
export function categorize<C extends string>(
	category: C,
	patterns: ([Pattern, string] | [Pattern])[],
	opts?: { recurring?: Rule<C>["recurring"] },
): Rule<C>[] {
	return patterns.map(([match, payee]) => ({
		match,
		payee,
		category,
		...(opts?.recurring ? { recurring: opts.recurring } : {}),
	}));
}
