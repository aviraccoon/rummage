/**
 * Initialize a data directory for rummage.
 * Creates directory structure and stub config files.
 * Respects existing files - won't overwrite anything.
 *
 * Usage: bun run init [target-dir]
 * Default target: ./data
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const targetDir = process.argv[2] || "data";

interface FileStub {
	path: string;
	content: string;
}

const directories = ["raw", "generated"];

const stubs: FileStub[] = [
	{
		path: "accounts.ts",
		content: `/**
 * Account definitions and mappings.
 * Define your accounts and map bank account IDs to rummage accounts.
 */

import type { OfxAccountMapping } from "../src/importers/ofx.ts";
import type { Account } from "../src/types.ts";

/**
 * Map bank account IDs to rummage accounts.
 * Used by OFX-based importers (Fio, generic OFX, etc.)
 * If not mapped, accounts are auto-generated as Assets:{Source}:{currency}
 */
export const accountMappings: OfxAccountMapping = {
	// "1234567890": { account: "Assets:Bank:Checking", currency: "CZK" },
};

export const accounts: Account[] = [
	// Assets - your bank accounts, cash, etc.
	// { name: "Assets:Bank:Checking", type: "asset", currency: "CZK" },

	// Income
	// { name: "Income:Salary", type: "income" },

	// Expenses - add categories as needed
	// { name: "Expenses:Food:Groceries", type: "expense" },
	{ name: "Expenses:Uncategorized", type: "expense" },

	// Equity (for opening balances)
	{ name: "Equity:Opening-Balances", type: "equity" },
];
`,
	},
	{
		path: "categories.ts",
		content: `/**
 * Category definitions with descriptions.
 * Define your expense/income categories here.
 * Use JSDoc comments for editor hover descriptions.
 */

import type { LeafValues } from "../src/type-utils.ts";

export const C = {
	income: {
		/** Regular employment income */
		salary: "Income:Salary",
		/** Freelance, side projects, misc income */
		other: "Income:Other",
	},
	// Add your expense categories here:
	// food: {
	// 	/** Supermarkets - groceries for cooking at home */
	// 	groceries: "Expenses:Food:Groceries",
	// 	/** Restaurants, delivery - prepared food */
	// 	dining: "Expenses:Food:Dining",
	// },
	/** Fallback for unmatched transactions */
	uncategorized: "Expenses:Uncategorized",
} as const;

/** Union of all valid category strings */
export type Category = LeafValues<typeof C>;
`,
	},
	{
		path: "rules.ts",
		content: `/**
 * Categorization rules.
 * Rules are matched in order - first match wins.
 * Use regex patterns to match transaction names/memos.
 */

import type { Rule } from "../src/types.ts";
import { C, type Category } from "./categories.ts";

export const rules: Rule<Category>[] = [
	// Examples:
	//
	// Subscriptions - exact service matches
	// {
	// 	match: /SPOTIFY/i,
	// 	payee: "Spotify",
	// 	category: C.subscriptions.spotify,
	// 	recurring: "monthly",
	// },
	//
	// Food - multiple patterns
	// {
	// 	match: /ALBERT|BILLA|TESCO|LIDL/i,
	// 	category: C.food.groceries,
	// },
	//
	// Income
	// {
	// 	match: /Salary|PAYROLL/i,
	// 	category: C.income.salary,
	// },

	// Catch-all - anything unmatched goes here
	{
		match: /.*/,
		category: C.uncategorized,
	},
];
`,
	},
	{
		path: "overrides.ts",
		content: `/**
 * Transaction overrides.
 * Fix individual transactions by ID.
 *
 * Transaction ID format varies by bank:
 * - Fio: fio-{accountId}-{fitId}
 * - Revolut: revolut-{accountId}-{legId}
 *
 * Find IDs in the generated output or source files.
 */

import type { Override } from "../src/types.ts";
import { C, type Category } from "./categories.ts";

export const overrides: Override<Category>[] = [
	// Examples:
	//
	// Fix category:
	// { id: "fio-1234567890-10007", category: C.food.groceries },
	//
	// Skip duplicate:
	// { id: "fio-1234567890-10099", skip: true },
	//
	// Add tags:
	// { id: "fio-1234567890-10005", tags: ["tax-deductible"] },
	//
	// Fix payee name:
	// { id: "fio-1234567890-10003", payee: "Correct Name" },
];
`,
	},
	{
		path: "locations.ts",
		content: `/**
 * Payee locations (optional).
 * Map payees to physical locations for geo-tagging transactions.
 */

import type { Location } from "../src/types";

interface PayeeLocations {
	payee: string;
	locations: Location[];
}

export const payeeLocations: PayeeLocations[] = [
	// Example:
	// {
	// 	payee: "Favorite Coffee Shop",
	// 	locations: [
	// 		{ name: "Downtown", coords: [50.0875, 14.4213] },
	// 		{ name: "Mall Location", coords: [50.0755, 14.4378] },
	// 	],
	// },
];
`,
	},
];

function main() {
	console.log(`\n🦝 Initializing rummage data directory: ${targetDir}/\n`);

	const created: string[] = [];
	const skipped: string[] = [];

	// Create target directory if needed
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
		created.push(`${targetDir}/`);
	}

	// Create subdirectories
	for (const dir of directories) {
		const dirPath = join(targetDir, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
			created.push(`${dir}/`);
		} else {
			skipped.push(`${dir}/`);
		}
	}

	// Create stub files
	for (const stub of stubs) {
		const filePath = join(targetDir, stub.path);
		const dir = join(targetDir, stub.path.split("/").slice(0, -1).join("/"));

		// Ensure parent directory exists
		if (dir && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		if (!existsSync(filePath)) {
			writeFileSync(filePath, stub.content);
			created.push(stub.path);
		} else {
			skipped.push(stub.path);
		}
	}

	// Report results
	if (created.length > 0) {
		console.log("Created:");
		for (const item of created) {
			console.log(`  + ${item}`);
		}
	}

	if (skipped.length > 0) {
		console.log("\nSkipped (already exist):");
		for (const item of skipped) {
			console.log(`  - ${item}`);
		}
	}

	console.log(`
Next steps:
  1. Add bank exports to ${targetDir}/raw/ (e.g., raw/fio/, raw/revolut/)
  2. Edit ${targetDir}/accounts.ts to map your account IDs
  3. Edit ${targetDir}/categories.ts to define your categories
  4. Edit ${targetDir}/rules.ts to categorize transactions
  5. Run: RUMMAGE_DATA_SOURCE=${targetDir} bun run build
`);
}

main();
