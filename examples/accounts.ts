/**
 * Example account structure.
 * Copy to data/accounts.ts and customize for your accounts.
 */

import type { OfxAccountMapping } from "../src/importers/ofx.ts";
import type { Account } from "../src/types.ts";

/**
 * Map bank account IDs to rummage accounts.
 * Optional - if not provided, accounts are auto-generated from source data.
 * Used by OFX-based importers (Fio, generic OFX, etc.)
 */
export const accountMappings: OfxAccountMapping = {
	// Fio accounts
	"1234567890": { account: "Assets:Bank:Checking", currency: "CZK" },
	"9876543210": { account: "Assets:Bank:Savings", currency: "CZK" },
	// Add more account ID → account mappings as needed
	// If not mapped, accounts are auto-generated as Assets:{Source}:{currency}
};

export const accounts: Account[] = [
	// Assets
	{ name: "Assets:Bank:Checking", type: "asset", currency: "CZK" },
	{ name: "Assets:Bank:Savings", type: "asset", currency: "CZK" },
	{ name: "Assets:Bank-9999:EUR", type: "asset", currency: "EUR" }, // Auto-generated from OFX
	{ name: "Assets:Cash", type: "asset" },

	// Income
	{ name: "Income:Salary", type: "income" },
	{ name: "Income:Other", type: "income" },

	// Expenses
	{ name: "Expenses:Food:Delivery", type: "expense" },
	{ name: "Expenses:Food:Groceries", type: "expense" },
	{ name: "Expenses:Food:Coffee", type: "expense" },
	{ name: "Expenses:Subscriptions:Spotify", type: "expense" },
	{ name: "Expenses:Subscriptions:Netflix", type: "expense" },
	{ name: "Expenses:Shopping", type: "expense" },
	{ name: "Expenses:Housing:Rent", type: "expense" },
	{ name: "Expenses:Bank:Fees", type: "expense" },
	{ name: "Expenses:Uncategorized", type: "expense" },

	// Equity (for opening balances)
	{ name: "Equity:Opening-Balances", type: "equity" },
];
