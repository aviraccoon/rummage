/**
 * Example payee locations.
 * Copy to data/locations.ts and customize for your area.
 */

import type { Location } from "../src/types";

interface PayeeLocations {
	payee: string;
	locations: Location[];
}

export const payeeLocations: PayeeLocations[] = [
	{
		payee: "Starbucks",
		locations: [
			{ name: "Starbucks Downtown", coords: [40.7128, -74.006] },
			{ name: "Starbucks Uptown", coords: [40.7831, -73.9712] },
		],
	},
	{
		payee: "Whole Foods",
		locations: [{ name: "Whole Foods Main St", coords: [40.7282, -73.9942] }],
	},
	{
		payee: "Local Coffee Shop",
		locations: [{ name: "The Cozy Bean", coords: [40.7352, -73.9911] }],
	},
];
