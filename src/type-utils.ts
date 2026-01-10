/**
 * Type utilities for extracting types from const objects.
 */

/**
 * Extract all leaf string values from a nested const object as a union type.
 *
 * @example
 * const C = { food: { groceries: "Expenses:Food" } } as const;
 * type Category = LeafValues<typeof C>; // "Expenses:Food"
 */
export type LeafValues<T> = T extends string
	? T
	: { [K in keyof T]: LeafValues<T[K]> }[keyof T];
