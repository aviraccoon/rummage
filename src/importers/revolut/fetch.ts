#!/usr/bin/env bun
/**
 * Interactive CLI for fetching Revolut transactions.
 *
 * Usage:
 *   bun run src/importers/revolut/fetch.ts                # default: raw/revolut/
 *   bun run src/importers/revolut/fetch.ts --name personal  # raw/revolut-personal/
 *
 * Prompts for a cURL command copied from browser DevTools, fetches all
 * transactions, and saves them to the output directory.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { config } from "../../config.ts";
import { loadSourceConfig } from "../../registry.ts";
import { requireRealData } from "../utils.ts";
import {
	deduplicateTransactions,
	detectCurrency,
	epochToIsoDate,
	fetchAllTransactions,
	groupByYear,
	parseCurlCommand,
	type RevolutAuth,
	type RevolutTransaction,
	sortByDate,
} from "./api.ts";

/** Build output directory path */
export function buildOutputDir(rawDir: string, name?: string): string {
	if (!name) return join(rawDir, "revolut");
	return join(rawDir, `revolut-${name}`);
}

/** Discover existing Revolut directories */
export async function discoverRevolutDirs(
	rawDir: string,
): Promise<Array<{ path: string; name: string }>> {
	const dirs: Array<{ path: string; name: string }> = [];

	if (!existsSync(rawDir)) return dirs;

	for (const entry of readdirSync(rawDir)) {
		const entryPath = join(rawDir, entry);
		if (!statSync(entryPath).isDirectory()) continue;

		// Match "revolut" or "revolut-*"
		if (entry === "revolut" || entry.startsWith("revolut-")) {
			dirs.push({ path: entryPath, name: entry });
			continue;
		}

		// Check rummage.ts for importer: "revolut"
		const config = await loadSourceConfig(entryPath);
		if (config?.importer === "revolut") {
			dirs.push({ path: entryPath, name: entry });
		}
	}

	return dirs;
}

async function promptMultiline(prompt: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	console.log(prompt);
	console.log(
		"(Paste your cURL command, then press Enter twice to continue)\n",
	);

	return new Promise((resolve) => {
		const lines: string[] = [];
		let emptyLineCount = 0;

		rl.on("line", (line) => {
			if (line === "") {
				emptyLineCount++;
				if (emptyLineCount >= 1 && lines.length > 0) {
					rl.close();
					resolve(lines.join("\n"));
				}
			} else {
				emptyLineCount = 0;
				lines.push(line);
			}
		});

		rl.on("close", () => {
			resolve(lines.join("\n"));
		});
	});
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${question} [Y/n] `, (answer) => {
			rl.close();
			const normalized = answer.trim().toLowerCase();
			resolve(normalized === "" || normalized === "y" || normalized === "yes");
		});
	});
}

function loadExistingTransactions(filePath: string): RevolutTransaction[] {
	if (!existsSync(filePath)) {
		return [];
	}
	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as RevolutTransaction[];
	} catch {
		console.warn(`Warning: Could not parse ${filePath}, starting fresh`);
		return [];
	}
}

/** Show date coverage of existing JSON files in the output directory */
function showExistingCoverage(outputDir: string): void {
	if (!existsSync(outputDir)) return;

	const files = readdirSync(outputDir)
		.filter((f) => f.endsWith(".json"))
		.sort();

	if (files.length === 0) return;

	console.log("Existing data:");
	for (const file of files) {
		const filePath = join(outputDir, file);
		try {
			const txns = JSON.parse(
				readFileSync(filePath, "utf-8"),
			) as RevolutTransaction[];
			if (txns.length === 0) {
				console.log(`  ${file}: empty`);
				continue;
			}
			// Transactions are sorted newest-first
			const newest = txns[0];
			const oldest = txns[txns.length - 1];
			if (!newest || !oldest) continue;
			const from = epochToIsoDate(oldest.startedDate);
			const to = epochToIsoDate(newest.startedDate);
			const desc = newest.description ?? newest.type ?? "";
			const amount = (newest.amount / 100).toFixed(2);
			const time = new Date(newest.startedDate).toISOString().slice(11, 16);
			console.log(
				`  ${file}: ${txns.length} txns, ${from} → ${to} ${time} ${amount} ${desc}`,
			);
		} catch {
			console.log(`  ${file}: unreadable`);
		}
	}
	console.log();
}

function saveTransactions(
	filePath: string,
	transactions: RevolutTransaction[],
): void {
	const sorted = sortByDate(transactions);
	writeFileSync(filePath, JSON.stringify(sorted, null, "\t"));
}

async function main() {
	requireRealData();
	const RAW_DIR = config.rawPath;

	// Parse arguments
	const { values } = parseArgs({
		options: {
			name: { type: "string", short: "n" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
	});

	if (values.help) {
		console.log(`Usage: bun run src/importers/revolut/fetch.ts [options]

Options:
  -n, --name NAME    Output directory suffix (e.g., personal → revolut-personal)
  -h, --help         Show this help

Examples:
  fetch.ts                    # saves to raw/revolut/
  fetch.ts --name personal    # saves to raw/revolut-personal/
`);
		process.exit(0);
	}

	console.log("🦝 Revolut Transaction Fetcher\n");

	// Show existing Revolut directories
	const existingDirs = await discoverRevolutDirs(RAW_DIR);
	if (existingDirs.length > 0) {
		console.log("Existing Revolut directories:");
		for (const dir of existingDirs) {
			console.log(`  - ${dir.name}`);
		}
		console.log();
	}

	// Determine output directory
	const outputDir = buildOutputDir(RAW_DIR, values.name);
	const outputName = values.name ? `revolut-${values.name}` : "revolut";
	console.log(`Output: ${outputName}/\n`);

	// Show existing data coverage
	showExistingCoverage(outputDir);

	console.log("Instructions:");
	console.log("1. Go to https://app.revolut.com and log in");
	console.log("2. Click 'See all' transactions for the currency you want");
	console.log("3. Open DevTools (F12) → Network tab");
	console.log("4. Find the request to 'transactions/last'");
	console.log("5. Right-click → Copy → Copy as cURL");
	console.log(
		"\nNote: Only auth is extracted from the cURL — URL params are ignored.",
	);
	console.log(
		"All transactions are fetched from newest to oldest, then deduped against existing files.\n",
	);

	const curlInput = await promptMultiline("Paste your cURL command:");

	if (!curlInput.trim()) {
		console.error("No input provided. Exiting.");
		process.exit(1);
	}

	// Parse auth from cURL
	let auth: RevolutAuth;
	try {
		auth = parseCurlCommand(curlInput);
		console.log("\n✓ Parsed authentication data");
		console.log(`  Pocket ID: ${auth.pocketId.slice(0, 8)}...`);
	} catch (error) {
		console.error(
			`\n✗ Failed to parse cURL: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}

	// Fetch transactions
	console.log("\nFetching transactions...");
	let transactions: RevolutTransaction[];
	try {
		transactions = await fetchAllTransactions(auth, {
			onProgress: ({ total, month, added, status }) => {
				const statusIcon =
					status === "fetching"
						? "⏳"
						: status === "found"
							? "✓"
							: status === "empty"
								? "·"
								: "⏹";
				const addedText = status === "found" ? ` (+${added})` : "";
				console.log(`  ${statusIcon} ${month}: ${total} total${addedText}`);
			},
		});
		console.log(`\n✓ Fetched ${transactions.length} transactions`);
	} catch (error) {
		console.error(
			`\n✗ Fetch failed: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}

	if (transactions.length === 0) {
		console.log("\nNo transactions found.");
		process.exit(0);
	}

	// Detect currency
	const currency = detectCurrency(transactions);
	console.log(`  Currency: ${currency}`);

	// Group by year
	const byYear = groupByYear(transactions);
	console.log(`  Years: ${[...byYear.keys()].sort().join(", ")}`);

	// Ensure output directory exists
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	// Process each year
	console.log("\nSaving to files:");
	let totalAdded = 0;
	let totalDuplicates = 0;

	for (const [year, yearTransactions] of byYear) {
		const fileName = `${currency}_${year}.json`;
		const filePath = join(outputDir, fileName);

		const existing = loadExistingTransactions(filePath);
		const { merged, added, duplicates } = deduplicateTransactions(
			existing,
			yearTransactions,
		);

		saveTransactions(filePath, merged);

		const status =
			existing.length > 0
				? `${added} new, ${duplicates} duplicates (${merged.length} total)`
				: `${merged.length} transactions`;

		console.log(`  ${fileName}: ${status}`);
		totalAdded += added;
		totalDuplicates += duplicates;
	}

	console.log(
		`\n✓ Done! Added ${totalAdded} new transactions, skipped ${totalDuplicates} duplicates.`,
	);

	// Remind about other currencies
	const proceed = await confirm("\nDo you have another currency to fetch?");
	if (proceed) {
		console.log(
			"\nSwitch to the other currency in Revolut web app and run this script again.",
		);
	}
}

// Only run when executed directly, not when imported
if (import.meta.main) {
	main().catch((error) => {
		console.error("Unexpected error:", error);
		process.exit(1);
	});
}
