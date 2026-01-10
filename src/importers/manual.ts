/**
 * Manual transaction importer.
 * Loads TypeScript files that export Transaction arrays.
 *
 * Expected file format:
 * ```ts
 * import type { Transaction } from "../../src/types.ts";
 * export const transactions: Transaction[] = [...];
 * ```
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ImportError, ImportResult, Transaction } from "../types.ts";

/**
 * Import all .ts files from a manual transactions directory.
 * Each file should export a `transactions` array.
 */
export async function importManualDirectory(
	dirPath: string,
): Promise<ImportResult> {
	const transactions: Transaction[] = [];
	const errors: ImportError[] = [];

	const absoluteDirPath = resolve(dirPath);

	if (!existsSync(absoluteDirPath)) {
		return { transactions, errors };
	}

	const files = readdirSync(absoluteDirPath).filter(
		(f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "rummage.ts",
	);

	for (const file of files) {
		const filePath = join(absoluteDirPath, file);
		try {
			const module = await import(filePath);

			// Skip files without transactions export (allows utils, helpers, etc.)
			if (!module.transactions) {
				continue;
			}

			if (!Array.isArray(module.transactions)) {
				errors.push({
					source: filePath,
					message: `'transactions' export is not an array`,
				});
				continue;
			}

			// Add source field if not set
			for (const txn of module.transactions as Transaction[]) {
				if (!txn.source) {
					txn.source = filePath;
				}
				transactions.push(txn);
			}
		} catch (err) {
			errors.push({
				source: filePath,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { transactions, errors };
}
