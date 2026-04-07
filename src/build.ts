/**
 * Main pipeline orchestration.
 *
 * Flow:
 * 1. Discover source directories in raw/
 * 2. Auto-detect or use rummage.ts config for each
 * 3. Run appropriate importers to produce Transaction[]
 * 4. Apply categorization rules
 * 5. Apply overrides
 * 6. Generate beancount output
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_PATH } from "./config.ts";
import { writeBeancount } from "./output/beancount.ts";
import { applyOverrides, loadAllOverrides } from "./overrides.ts";
import { importAllSources } from "./registry.ts";
import { applyRules } from "./rules.ts";
import type {
	BalanceAssertion,
	CommodityDefinition,
	Price,
	Rule,
	Transaction,
} from "./types.ts";

/** Discover supplementary beancount files in the generated directory. */
function discoverIncludes(generatedPath: string): string[] {
	if (!existsSync(generatedPath)) return [];
	return readdirSync(generatedPath)
		.filter(
			(f) =>
				f.endsWith(".beancount") &&
				f !== "main.beancount" &&
				!f.startsWith("_"),
		)
		.sort();
}

async function loadDataConfig() {
	// Dynamically import the data source's config files
	const accountsModule = await import(join(DATA_PATH, "accounts.ts"));
	const rulesModule = await import(join(DATA_PATH, "rules.ts"));

	return {
		accounts: accountsModule.accounts,
		// Account mappings are optional - importers auto-generate if not provided
		accountMappings: accountsModule.accountMappings,
		rules: rulesModule.rules as Rule[],
	};
}

/** Get all source files from a directory (for override matching) */
function getAllSourceFiles(rawPath: string): string[] {
	if (!existsSync(rawPath)) return [];

	const sourceFiles: string[] = [];
	const entries = readdirSync(rawPath, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

		const dirPath = join(rawPath, entry.name);
		const files = readdirSync(dirPath);

		for (const file of files) {
			if (
				file.endsWith(".ofx") ||
				file.endsWith(".json") ||
				file.endsWith(".csv")
			) {
				sourceFiles.push(join(dirPath, file));
			}
		}
	}

	return sourceFiles;
}

async function main() {
	console.log(`🦝 rummage build`);
	console.log(`   Data source: ${config.dataSource}`);
	console.log("");

	// Load configuration
	const { accounts, accountMappings, rules } = await loadDataConfig();

	// Discover and import all sources
	console.log(`📁 Discovering sources in ${config.rawPath}`);
	const { results, skipped, warnings, duplicatesRemoved } =
		await importAllSources(config.rawPath, { accountMapping: accountMappings });

	// Log discovery results
	for (const result of results) {
		console.log(
			`   ${result.name}/ → ${result.importer} (${result.transactions.length} transactions)`,
		);
	}
	if (skipped.length > 0) {
		console.log(`   Skipped: ${skipped.join(", ")}`);
	}
	for (const warning of warnings) {
		console.log(`   ⚠️  ${warning}`);
	}
	if (duplicatesRemoved > 0) {
		console.log(`   ✓ ${duplicatesRemoved} duplicate(s) removed`);
	}

	// Collect all transactions, errors, balance assertions, opening balances, and prices
	let allTransactions: Transaction[] = results.flatMap((r) => r.transactions);
	const allErrors = results.flatMap((r) => r.errors);
	const allBalanceAssertions: BalanceAssertion[] = results.flatMap(
		(r) => r.balanceAssertions ?? [],
	);
	const allOpeningBalances: BalanceAssertion[] = results.flatMap(
		(r) => r.openingBalances ?? [],
	);
	const allPrices: Price[] = results.flatMap((r) => r.prices ?? []);
	const allCommodities: CommodityDefinition[] = results.flatMap(
		(r) => r.commodities ?? [],
	);

	// Write supplementary beancount files from importers
	const supplementaryFiles: string[] = [];
	for (const result of results) {
		if (result.supplementaryBeancount) {
			const filename = `${result.name}.beancount`;
			const filePath = join(config.generatedPath, filename);
			writeFileSync(filePath, result.supplementaryBeancount);
			supplementaryFiles.push(filename);
		}
	}

	// Apply categorization rules
	console.log(`\n📋 Applying ${rules.length} categorization rules`);
	allTransactions = applyRules(allTransactions, rules);

	// Load and apply overrides
	const sourceFiles = getAllSourceFiles(config.rawPath);
	const overrides = await loadAllOverrides(DATA_PATH, sourceFiles);
	if (overrides.length > 0) {
		console.log(`\n🔧 Applying ${overrides.length} overrides`);
		const overrideResult = applyOverrides(allTransactions, overrides);
		allTransactions = overrideResult.transactions;

		if (overrideResult.applied > 0) {
			console.log(`   ✓ ${overrideResult.applied} transactions updated`);
		}
		if (overrideResult.skipped > 0) {
			console.log(`   ✓ ${overrideResult.skipped} transactions skipped`);
		}
		if (overrideResult.unmatched.length > 0) {
			console.log(
				`   ⚠️  ${overrideResult.unmatched.length} overrides didn't match:`,
			);
			for (const id of overrideResult.unmatched.slice(0, 5)) {
				console.log(`      - ${id}`);
			}
			if (overrideResult.unmatched.length > 5) {
				console.log(
					`      ... and ${overrideResult.unmatched.length - 5} more`,
				);
			}
		}
	}

	// Count uncategorized (after rules + overrides)
	const uncategorized = allTransactions.filter(
		(t) => t.category === "Expenses:Uncategorized",
	);
	if (uncategorized.length > 0) {
		console.log(`\n   ⚠️  ${uncategorized.length} uncategorized transactions`);
	}

	// Ensure generated directory exists
	if (!existsSync(config.generatedPath)) {
		mkdirSync(config.generatedPath, { recursive: true });
	}

	// Write beancount output
	const beancountPath = join(config.generatedPath, "main.beancount");
	console.log(`\n📝 Writing ${beancountPath}`);
	if (allOpeningBalances.length > 0) {
		console.log(`   Including ${allOpeningBalances.length} opening balance(s)`);
	}
	if (allBalanceAssertions.length > 0) {
		console.log(
			`   Including ${allBalanceAssertions.length} balance assertion(s)`,
		);
	}
	if (allPrices.length > 0) {
		console.log(`   Including ${allPrices.length} price directive(s)`);
	}
	// Discover supplementary beancount files (importer-generated + pre-existing)
	const includes = discoverIncludes(config.generatedPath);
	if (includes.length > 0) {
		console.log(
			`   Including ${includes.length} supplementary file(s): ${includes.join(", ")}`,
		);
	}

	if (allCommodities.length > 0) {
		console.log(
			`   Including ${allCommodities.length} commodity definition(s)`,
		);
	}

	writeBeancount(
		beancountPath,
		allTransactions,
		accounts,
		allBalanceAssertions,
		allPrices,
		allOpeningBalances,
		includes,
		allCommodities,
	);

	// Report errors
	if (allErrors.length > 0) {
		console.log(`\n⚠️  ${allErrors.length} errors:`);
		for (const err of allErrors) {
			console.log(`   ${err.source}: ${err.message}`);
		}
	}

	console.log(`\n✅ Done! View with: fava ${beancountPath}`);
}

main().catch((err) => {
	console.error("Build failed:", err);
	process.exit(1);
});
