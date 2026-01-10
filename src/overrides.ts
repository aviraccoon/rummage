/**
 * Override handling for transaction corrections.
 *
 * Supports:
 * - Global overrides: {dataPath}/overrides.ts
 * - Per-file overrides: raw/fio/2025-12.overrides.ts for raw/fio/2025-12.ofx
 */

import { existsSync } from "node:fs";
import type { Override, Transaction } from "./types.ts";

export interface OverrideResult {
	transactions: Transaction[];
	/** Number of overrides applied */
	applied: number;
	/** Number of skipped transactions */
	skipped: number;
	/** Override IDs that didn't match any transaction */
	unmatched: string[];
}

/**
 * Apply overrides to transactions.
 * Overrides are matched by transaction ID.
 */
export function applyOverrides(
	transactions: Transaction[],
	overrides: Override[],
): OverrideResult {
	const overrideMap = new Map(overrides.map((o) => [o.id, o]));
	const matchedIds = new Set<string>();

	let skipped = 0;
	const result: Transaction[] = [];

	for (const txn of transactions) {
		const override = overrideMap.get(txn.id);

		if (!override) {
			result.push(txn);
			continue;
		}

		matchedIds.add(txn.id);

		// Skip transaction entirely
		if (override.skip) {
			skipped++;
			continue;
		}

		// Apply override fields
		result.push({
			...txn,
			category: override.category ?? txn.category,
			payee: override.payee ?? txn.payee,
			memo: override.memo ?? txn.memo,
			tags: override.tags ? [...(txn.tags ?? []), ...override.tags] : txn.tags,
		});
	}

	// Find unmatched override IDs
	const unmatched = overrides
		.filter((o) => !matchedIds.has(o.id))
		.map((o) => o.id);

	return {
		transactions: result,
		applied: matchedIds.size - skipped,
		skipped,
		unmatched,
	};
}

/**
 * Get the override file path for a given source file.
 * e.g., raw/fio/2025-12.ofx -> raw/fio/2025-12.overrides.ts
 */
export function getOverrideFilePath(sourceFile: string): string | null {
	// Remove extension and add .overrides.ts
	const base = sourceFile.replace(/\.[^.]+$/, "");
	const overridePath = `${base}.overrides.ts`;

	return existsSync(overridePath) ? overridePath : null;
}

/**
 * Load overrides from a TypeScript file.
 * Expects: export const overrides: Override[] = [...]
 */
export async function loadOverrides(filePath: string): Promise<Override[]> {
	if (!existsSync(filePath)) {
		return [];
	}

	const module = await import(filePath);
	return (module.overrides ?? []) as Override[];
}

/**
 * Load all overrides: global + per-file.
 */
export async function loadAllOverrides(
	dataPath: string,
	sourceFiles: string[],
): Promise<Override[]> {
	const allOverrides: Override[] = [];

	// Load global overrides
	const globalPath = `${dataPath}/overrides.ts`;
	const globalOverrides = await loadOverrides(globalPath);
	allOverrides.push(...globalOverrides);

	// Load per-file overrides
	for (const sourceFile of sourceFiles) {
		const overridePath = getOverrideFilePath(sourceFile);
		if (overridePath) {
			const fileOverrides = await loadOverrides(overridePath);
			allOverrides.push(...fileOverrides);
		}
	}

	return allOverrides;
}
