/**
 * Per-file overrides for 2025-12.ofx
 */

import type { Override } from "../../../src/types.ts";

export const overrides: Override[] = [
	// Example per-file override - this transaction is specific to this month's file
	{
		id: "fio-1234567890-10009",
		memo: "Per-file override test",
	},
];
