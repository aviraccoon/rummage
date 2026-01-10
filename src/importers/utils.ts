/**
 * Shared utilities for importer/fetcher scripts.
 */

import { config } from "../config.ts";

/**
 * Ensure we're not running against examples directory.
 * Call this at the start of fetch scripts to prevent accidents.
 * After this passes, config.rawPath is guaranteed to be data/raw.
 */
export function requireRealData(): void {
	if (config.isUsingExamples) {
		console.error(
			"Error: Cannot fetch to examples directory.\n" +
				"Set RUMMAGE_DATA_SOURCE=data to use real data directory.",
		);
		process.exit(1);
	}
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
