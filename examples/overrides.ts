/**
 * Example transaction overrides.
 * Copy to data/overrides.ts and add your corrections.
 *
 * Transaction ID format: {bankPrefix}-{accountId}-{fitId}
 * Find IDs by checking the source OFX files for FITID values.
 */

import type { Override } from "../src/types.ts";
import { C, type Category } from "./categories.ts";

export const overrides: Override<Category>[] = [
	// Savings transfer - in real usage, add a proper transfer category
	{
		id: "fio-1234567890-10007",
		category: C.uncategorized,
		memo: "Transfer to savings account",
	},

	// More examples (commented out):
	//
	// Skip duplicate transaction:
	// { id: "fio-1234567890-10099", skip: true },
	//
	// Add tags for tax purposes:
	// { id: "fio-1234567890-10005", tags: ["tax-deductible"], memo: "Business expense" },
	//
	// Fix payee name:
	// { id: "fio-1234567890-10003", payee: "Correct Payee Name" },
];
