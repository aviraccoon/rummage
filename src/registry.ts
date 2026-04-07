/**
 * Importer registry for auto-discovery of data sources.
 *
 * Resolution order:
 * 1. rummage.ts config specifies importer → use that
 * 2. Directory name matches known bank → use bank-specific importer
 * 3. Scan files for known formats → use first matching format importer
 * 4. No match → skip with warning
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { importAmundiDirectory } from "./importers/amundi/transform.ts";
import { importConseqDirectory } from "./importers/conseq/transform.ts";
import { importFioDirectory } from "./importers/fio/transform.ts";
import { importManualDirectory } from "./importers/manual.ts";
import { importOfxDirectory } from "./importers/ofx.ts";
import { importRevolutDirectory } from "./importers/revolut/transform.ts";
import type {
	Importer,
	ImportOptions,
	SourceConfig,
} from "./importers/types.ts";
import type { BalanceAssertion, ImportResult } from "./types.ts";

/**
 * Registry of available importers.
 * Order matters: bank-specific importers should come before generic format importers.
 */
export const importers: Importer[] = [
	// Bank-specific importers (matched by directory name)
	{
		name: "amundi",
		directoryMatch: "amundi",
		import: (dirPath) => importAmundiDirectory(dirPath),
	},
	{
		name: "conseq",
		directoryMatch: "conseq",
		import: (dirPath) => importConseqDirectory(dirPath),
	},
	{
		name: "fio",
		directoryMatch: "fio",
		import: (dirPath, options) =>
			importFioDirectory(dirPath, {
				accountMapping: options.accountMapping,
				bankPrefix: "fio",
			}),
	},
	{
		name: "revolut",
		directoryMatch: "revolut",
		import: (dirPath, options) =>
			importRevolutDirectory(dirPath, {
				accountBase: options.accountBase ?? options.account,
				categoryMapping: options.categoryMapping,
			}),
	},

	// Manual transactions (TypeScript files)
	{
		name: "manual",
		directoryMatch: "manual",
		import: (dirPath) => importManualDirectory(dirPath),
	},

	// Generic format importers (matched by file detection)
	{
		name: "ofx",
		detect: (files) => files.some((f) => f.toLowerCase().endsWith(".ofx")),
		import: (dirPath, options) =>
			importOfxDirectory(dirPath, {
				accountMapping: options.accountMapping,
				accountBase: options.accountBase ?? options.account,
			}),
	},
];

/**
 * Find an importer by name.
 */
export function getImporterByName(name: string): Importer | undefined {
	return importers.find((i) => i.name === name);
}

/**
 * Find an importer for a directory by matching directory name.
 * Supports exact match ("revolut") and prefix match ("revolut-personal").
 */
export function matchByDirectoryName(dirName: string): Importer | undefined {
	const lower = dirName.toLowerCase();
	return importers.find((importer) => {
		if (!importer.directoryMatch) return false;
		const matches = Array.isArray(importer.directoryMatch)
			? importer.directoryMatch
			: [importer.directoryMatch];
		return matches.some(
			(match) => lower === match || lower.startsWith(`${match}-`),
		);
	});
}

/**
 * Find an importer by detecting file types in directory.
 */
export function matchByFileDetection(dirPath: string): Importer | undefined {
	const files = readdirSync(dirPath);
	return importers.find((importer) => importer.detect?.(files));
}

/**
 * Find the appropriate importer for a directory.
 */
export function findImporter(
	dirName: string,
	dirPath: string,
	config?: SourceConfig,
): Importer | undefined {
	// 1. Config specifies importer explicitly
	if (config?.importer) {
		return getImporterByName(config.importer);
	}

	// 2. Match by directory name
	const byName = matchByDirectoryName(dirName);
	if (byName) return byName;

	// 3. Detect by file types
	return matchByFileDetection(dirPath);
}

/**
 * Load rummage.ts config from a directory if it exists.
 */
export async function loadSourceConfig(
	dirPath: string,
): Promise<SourceConfig | undefined> {
	const configPath = join(dirPath, "rummage.ts");
	if (!existsSync(configPath)) {
		return undefined;
	}

	const module = await import(configPath);
	return module.source as SourceConfig;
}

/**
 * Result of discovering and importing from a single source directory.
 */
export interface SourceImportResult extends ImportResult {
	/** Directory name */
	name: string;
	/** Importer used */
	importer: string;
}

/**
 * Deduplicate transactions by ID, keeping the first occurrence.
 */
export function deduplicateTransactions(results: SourceImportResult[]): {
	results: SourceImportResult[];
	duplicatesRemoved: number;
} {
	const seen = new Set<string>();
	let duplicatesRemoved = 0;

	const deduped = results.map((result) => ({
		...result,
		transactions: result.transactions.filter((txn) => {
			if (seen.has(txn.id)) {
				duplicatesRemoved++;
				return false;
			}
			seen.add(txn.id);
			return true;
		}),
	}));

	return { results: deduped, duplicatesRemoved };
}

/**
 * Discover and import all sources from a raw directory.
 */
export async function importAllSources(
	rawPath: string,
	options: ImportOptions = {},
): Promise<{
	results: SourceImportResult[];
	skipped: string[];
	warnings: string[];
	duplicatesRemoved: number;
}> {
	const results: SourceImportResult[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(rawPath)) {
		return { results, skipped, warnings, duplicatesRemoved: 0 };
	}

	const entries = readdirSync(rawPath);

	for (const entry of entries) {
		// Skip underscore-prefixed directories
		if (entry.startsWith("_")) {
			skipped.push(entry);
			continue;
		}

		const entryPath = join(rawPath, entry);

		// Skip non-directories
		if (!statSync(entryPath).isDirectory()) {
			continue;
		}

		// Load optional config
		const config = await loadSourceConfig(entryPath);

		// Skip if config says so
		if (config?.skip) {
			skipped.push(entry);
			continue;
		}

		// Find appropriate importer
		const importer = findImporter(entry, entryPath, config);

		if (!importer) {
			warnings.push(`No importer found for '${entry}', skipping`);
			continue;
		}

		// Build import options from config and defaults
		const importOptions: ImportOptions = {
			...options,
			account: config?.account ?? options.account,
			accountBase: config?.accountBase ?? options.accountBase,
			categoryMapping: config?.categoryMapping ?? options.categoryMapping,
		};

		// Run import (may be sync or async)
		const result = await importer.import(entryPath, importOptions);

		// Combine opening balances from import result and config
		let openingBalances = result.openingBalances;

		// If config specifies opening balances (for sources with incomplete data),
		// those override auto-detected ones for the same accounts
		if (config?.openingBalance) {
			const accountBase =
				config.accountBase ?? config.account ?? options.accountBase ?? "Assets";
			const configAccounts = new Set<string>();

			const configOpenings: BalanceAssertion[] = [];
			for (const [currency, amount] of Object.entries(
				config.openingBalance.balances,
			)) {
				const account = `${accountBase}:${currency}`;
				configAccounts.add(account);
				configOpenings.push({
					date: config.openingBalance.date,
					account,
					balance: { value: amount, currency },
					source: `${entry}/rummage.ts`,
				});
			}

			// Filter out auto-detected openings for accounts specified in config
			const filteredOpenings = (openingBalances ?? []).filter(
				(o) => !configAccounts.has(o.account),
			);
			openingBalances = [...filteredOpenings, ...configOpenings];
		}

		results.push({
			name: entry,
			importer: importer.name,
			transactions: result.transactions,
			errors: result.errors,
			balanceAssertions: result.balanceAssertions,
			openingBalances,
			prices: result.prices,
			commodities: result.commodities,
			supplementaryBeancount: result.supplementaryBeancount,
		});
	}

	// Deduplicate across all sources
	const { results: dedupedResults, duplicatesRemoved } =
		deduplicateTransactions(results);

	return { results: dedupedResults, skipped, warnings, duplicatesRemoved };
}
