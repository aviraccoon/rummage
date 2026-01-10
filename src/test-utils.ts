/**
 * Shared test utilities.
 */

import { expect } from "bun:test";

/** Assert value is defined and return it typed */
export function assertDefined<T>(
	value: T | undefined,
	msg = "Expected value to be defined",
): T {
	expect(value, msg).toBeDefined();
	return value as T;
}

/** Assert array has element at index and return it typed */
export function assertAt<T>(arr: T[], index: number): T {
	const value = arr.at(index);
	expect(value, `Expected element at index ${index}`).toBeDefined();
	return value as T;
}
