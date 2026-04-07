/**
 * Types for the source importer registry.
 */

import type { ImportResult } from "../types.ts";

/**
 * Per-directory configuration via rummage.ts.
 * All fields optional - missing file or fields = auto-detection.
 */
export interface SourceConfig {
	/** Force specific importer (skip auto-detection) */
	importer?: string;
	/** Override full account name */
	account?: string;
	/** Override account base (currency appended automatically) */
	accountBase?: string;
	/** Skip this directory entirely */
	skip?: boolean;
	/**
	 * Category mapping for importers that provide default categories.
	 * - omit: use importer defaults
	 * - Record<string, string>: override specific mappings (merged with defaults)
	 * - false: disable all importer category mapping (rely on rules only)
	 */
	categoryMapping?: Record<string, string> | false;
	/**
	 * Opening balance for sources that don't provide it in data (e.g., OFX).
	 * Used to generate opening balance transactions against Equity:Opening-Balances.
	 */
	openingBalance?: {
		/** Date of the opening balance (usually day before first transaction) */
		date: string;
		/** Currency → amount mapping */
		balances: Record<string, number>;
	};
}

/**
 * Options passed to importer functions.
 */
export interface ImportOptions {
	/** Account name or base from config */
	account?: string;
	accountBase?: string;
	/** Account mappings from user's accounts.ts (for OFX account ID → name) */
	accountMapping?: Record<string, { account: string; currency: string }>;
	/** Category mapping override for importers that provide default categories (e.g., Revolut) */
	categoryMapping?: Record<string, string> | false;
}

/**
 * An importer that can handle a specific bank or format.
 */
export interface Importer {
	/** Unique identifier */
	name: string;
	/** Match by directory name (string or array for aliases) */
	directoryMatch?: string | string[];
	/** Detect by files present (for generic format importers) */
	detect?: (files: string[]) => boolean;
	/** Import transactions from a directory (sync or async) */
	import: (
		dirPath: string,
		options: ImportOptions,
	) => ImportResult | Promise<ImportResult>;
}
