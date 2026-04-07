/**
 * Rule matching and application logic.
 */

import type { Rule, Transaction } from "./types.ts";

/** Check if a rule matches a transaction */
export function ruleMatches(rule: Rule, txn: Transaction): boolean {
	// match: checks name OR memo (either match = pass)
	if (rule.match) {
		const patterns = Array.isArray(rule.match) ? rule.match : [rule.match];
		const matched = patterns.some(
			(pattern) =>
				(txn.rawName && pattern.test(txn.rawName)) ||
				(txn.rawMemo && pattern.test(txn.rawMemo)) ||
				pattern.test(txn.description),
		);
		if (!matched) {
			return false;
		}
	}

	// matchName: checks only name
	if (rule.matchName) {
		if (!txn.rawName || !rule.matchName.test(txn.rawName)) {
			return false;
		}
	}

	// matchMemo: checks only memo
	if (rule.matchMemo) {
		if (!txn.rawMemo || !rule.matchMemo.test(txn.rawMemo)) {
			return false;
		}
	}

	// matchMetadata: checks metadata fields (all must match)
	if (rule.matchMetadata) {
		if (!txn.metadata) {
			return false;
		}
		for (const [key, pattern] of Object.entries(rule.matchMetadata)) {
			const value = txn.metadata[key];
			if (value === undefined || value === null) {
				return false;
			}
			if (!pattern.test(String(value))) {
				return false;
			}
		}
	}

	// matchFn: custom matcher function
	if (rule.matchFn) {
		if (!rule.matchFn(txn)) {
			return false;
		}
	}

	// At least one match field must be specified
	const hasAnyMatcher =
		rule.match ||
		rule.matchName ||
		rule.matchMemo ||
		rule.matchMetadata ||
		rule.matchFn;
	if (!hasAnyMatcher) {
		return false;
	}

	return true;
}

/** Apply rules to transactions, returning updated transactions */
export function applyRules(
	transactions: Transaction[],
	rules: Rule[],
): Transaction[] {
	return transactions.map((txn) => {
		// Skip if already categorized
		if (txn.category) return txn;

		// Find first matching rule
		for (const rule of rules) {
			if (ruleMatches(rule, txn)) {
				return {
					...txn,
					category: rule.category,
					payee: rule.payee ?? txn.payee,
					tags: rule.recurring
						? [...(txn.tags ?? []), "recurring", rule.recurring]
						: txn.tags,
				};
			}
		}

		return txn;
	});
}
