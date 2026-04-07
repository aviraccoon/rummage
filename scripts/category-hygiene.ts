/**
 * Category hygiene diagnostic.
 *
 * Finds transactions posted to parent categories when subcategories exist.
 * For example, if "Expenses:Shopping" and "Expenses:Shopping:Electronics" both
 * have transactions, the "Expenses:Shopping" ones should probably be refined.
 *
 * Usage:
 *   bun scripts/category-hygiene.ts [beancount-file]
 *   bun scripts/category-hygiene.ts path/to/main.beancount
 *
 * Default: reads from $RUMMAGE_DATA_SOURCE/generated/main.beancount
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_PATH } from "../src/config.ts";

const filePath =
	process.argv[2] || join(DATA_PATH, "generated", "main.beancount");

interface TransactionInfo {
	date: string;
	description: string;
	amount: string;
}

/**
 * Parse a beancount file and extract account → transaction mappings.
 * Associates each posting with the most recent transaction header.
 */
function parseBeancount(content: string): Map<string, TransactionInfo[]> {
	const accountTxns = new Map<string, TransactionInfo[]>();
	const lines = content.split("\n");

	let currentTxn: { date: string; description: string } | null = null;
	let currentAmount = "";

	for (const line of lines) {
		// Transaction header: 2024-01-15 * "Description" or 2024-01-15 * "Payee" "Description"
		const txnMatch = line.match(
			/^(\d{4}-\d{2}-\d{2})\s+[*!]\s+"([^"]*)"(?:\s+"([^"]*)")?/,
		);
		if (txnMatch) {
			const date = txnMatch[1] as string;
			const description = txnMatch[3] ?? txnMatch[2] ?? "";
			currentTxn = { date, description };
			currentAmount = "";
			continue;
		}

		if (!currentTxn) continue;

		// Posting line with amount (asset side): "  Assets:Revolut:CZK  -299.00 CZK"
		const amountMatch = line.match(/^\s+\S+:\S+\s+(-?[\d,.]+\s+\S+)/);
		if (amountMatch) {
			currentAmount = amountMatch[1] as string;
		}

		// Posting line without amount (expense/income side): "  Expenses:Shopping"
		const categoryMatch = line.match(/^\s+((?:Expenses|Income):\S+)\s*$/);
		if (categoryMatch) {
			const account = categoryMatch[1] as string;
			const txns = accountTxns.get(account) ?? [];
			txns.push({
				date: currentTxn.date,
				description: currentTxn.description,
				amount: currentAmount,
			});
			accountTxns.set(account, txns);
		}
	}

	return accountTxns;
}

/**
 * Find accounts that are strict prefixes of other accounts with transactions.
 */
function findParentCategories(accountTxns: Map<string, TransactionInfo[]>) {
	const accounts = [...accountTxns.keys()].sort();
	const results: {
		parent: string;
		parentCount: number;
		children: { account: string; count: number }[];
		sampleTxns: TransactionInfo[];
	}[] = [];

	for (const account of accounts) {
		const txns = accountTxns.get(account);
		if (!txns || txns.length === 0) continue;

		// Find children of this account
		const children = accounts
			.filter((other) => other.startsWith(`${account}:`) && other !== account)
			.map((child) => ({
				account: child,
				count: accountTxns.get(child)?.length ?? 0,
			}))
			.filter((c) => c.count > 0);

		if (children.length > 0) {
			results.push({
				parent: account,
				parentCount: txns.length,
				children,
				sampleTxns: txns.slice(0, 10),
			});
		}
	}

	return results;
}

function main() {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		console.error(`Cannot read file: ${filePath}`);
		console.error(
			"Usage: bun scripts/category-hygiene.ts [path/to/main.beancount]",
		);
		process.exit(1);
	}

	const accountTxns = parseBeancount(content);
	const parentCategories = findParentCategories(accountTxns);

	if (parentCategories.length === 0) {
		console.log("No parent categories with subcategories found. All clean!");
		return;
	}

	console.log(
		`Found ${parentCategories.length} parent categories that also have subcategories:\n`,
	);

	let totalAffected = 0;

	for (const {
		parent,
		parentCount,
		children,
		sampleTxns,
	} of parentCategories.sort((a, b) => b.parentCount - a.parentCount)) {
		totalAffected += parentCount;
		console.log(`── ${parent} (${parentCount} transactions) ──`);
		console.log("   Subcategories:");
		for (const child of children.sort((a, b) => b.count - a.count)) {
			const shortName = child.account.slice(parent.length + 1);
			console.log(`     ${shortName}: ${child.count}`);
		}
		console.log("   Sample transactions:");
		for (const txn of sampleTxns) {
			console.log(
				`     ${txn.date}  ${txn.amount.padEnd(16)} ${txn.description}`,
			);
		}
		if (parentCount > sampleTxns.length) {
			console.log(`     ... and ${parentCount - sampleTxns.length} more`);
		}
		console.log();
	}

	console.log(`Total: ${totalAffected} transactions in parent categories`);
}

main();
