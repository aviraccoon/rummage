/**
 * Category definitions with descriptions.
 * Using JSDoc comments for editor hover descriptions.
 */

import type { LeafValues } from "../src/type-utils.ts";

export const C = {
	income: {
		/** Regular employment income */
		salary: "Income:Salary",
		/** Freelance, side projects, misc income */
		other: "Income:Other",
	},
	food: {
		/** Supermarkets, Rohlik - ingredients for cooking at home */
		groceries: "Expenses:Food:Groceries",
		/** Wolt, Bolt Food - prepared food delivered */
		delivery: "Expenses:Food:Delivery",
		/** Cafes, Starbucks - drinks/snacks while out */
		coffee: "Expenses:Food:Coffee",
	},
	subscriptions: {
		/** Music streaming */
		spotify: "Expenses:Subscriptions:Spotify",
		/** Video streaming */
		netflix: "Expenses:Subscriptions:Netflix",
		/** Discord Nitro */
		discord: "Expenses:Subscriptions:Discord",
	},
	entertainment: {
		/** Steam, GOG, Epic - game purchases */
		games: "Expenses:Entertainment:Games",
	},
	transport: {
		/** Public transport - metro, tram, bus */
		public: "Expenses:Transport:Public",
	},
	housing: {
		/** Monthly rent payment */
		rent: "Expenses:Housing:Rent",
	},
	shopping: {
		/** Amazon, general online shopping */
		general: "Expenses:Shopping",
	},
	bank: {
		/** Card fees, account maintenance */
		fees: "Expenses:Bank:Fees",
	},
	/** Fallback for unmatched transactions */
	uncategorized: "Expenses:Uncategorized",
} as const;

/** Union of all valid category strings */
export type Category = LeafValues<typeof C>;
