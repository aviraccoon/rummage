/**
 * Manual transactions (cash, gifts, adjustments).
 * These are merged with imported bank transactions.
 */

import type { Transaction } from "../../../src/types.ts";
import { C } from "../../categories.ts";

/**
 * Helper to create manual transaction IDs.
 * Format: manual-{date}-{seq} where seq is a 3-digit sequence number.
 */
function manualId(date: string, seq: number): string {
	return `manual-${date}-${seq.toString().padStart(3, "0")}`;
}

export const transactions: Transaction[] = [
	{
		id: manualId("2026-01-01", 1),
		date: "2026-01-01",
		amount: { value: -25.0, currency: "USD" },
		description: "Cash tip to street musician",
		category: C.uncategorized,
		account: "Assets:Cash",
		source: "manual",
	},
	{
		id: manualId("2026-01-02", 1),
		date: "2026-01-02",
		amount: { value: -15.5, currency: "USD" },
		description: "Coffee shop (cash)",
		payee: "Local Coffee Shop",
		category: C.food.coffee,
		account: "Assets:Cash",
		source: "manual",
	},
];
