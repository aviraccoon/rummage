/**
 * Example categorization rules.
 * Copy to data/rules.ts and customize with your patterns.
 */

import type { Rule } from "../src/types.ts";
import { C, type Category } from "./categories.ts";

export const rules: Rule<Category>[] = [
	// Subscriptions
	{
		match: /SPOTIFY/i,
		payee: "Spotify",
		category: C.subscriptions.spotify,
		recurring: "monthly",
	},
	{
		match: /NETFLIX/i,
		payee: "Netflix",
		category: C.subscriptions.netflix,
		recurring: "monthly",
	},
	{
		match: /DISCORD.*NITRO/i,
		payee: "Discord",
		category: C.subscriptions.discord,
		recurring: "yearly",
	},

	// Entertainment
	{
		match: /STEAM/i,
		payee: "Steam",
		category: C.entertainment.games,
	},

	// Transport
	{
		match: /OVPAY|OV-CHIPKAART/i,
		payee: "OV Public Transport",
		category: C.transport.public,
	},

	// Food
	{
		match: /BOLT.*FOOD|WOLT|DODO/i,
		payee: "Food Delivery",
		category: C.food.delivery,
	},
	{
		match: /ALBERT|BILLA|TESCO|LIDL|ROHLIK/i,
		category: C.food.groceries,
	},
	{
		match: /STARBUCKS|COSTA COFFEE/i,
		payee: "Coffee Shop",
		category: C.food.coffee,
	},

	// Housing
	{
		match: /Rent/i,
		category: C.housing.rent,
		recurring: "monthly",
	},

	// Shopping
	{
		match: /AMAZON/i,
		payee: "Amazon",
		category: C.shopping.general,
	},

	// Bank fees
	{
		match: /Poplatek/i,
		category: C.bank.fees,
	},

	// Income
	{
		match: /Salary/i,
		category: C.income.salary,
	},

	// Catch-all - anything unmatched
	{
		match: /.*/,
		category: C.uncategorized,
	},
];
