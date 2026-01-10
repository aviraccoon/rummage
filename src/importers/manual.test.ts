import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXAMPLES_RAW } from "../config.ts";
import { importManualDirectory } from "./manual.ts";

describe("importManualDirectory", () => {
	test("imports transactions from examples/raw/manual", async () => {
		const result = await importManualDirectory(join(EXAMPLES_RAW, "manual"));

		expect(result.errors).toHaveLength(0);
		expect(result.transactions.length).toBeGreaterThan(0);

		const txn = result.transactions[0];
		expect(txn).toBeDefined();
		expect(txn?.id).toMatch(/^manual-/);
		expect(txn?.account).toBe("Assets:Cash");
	});

	test("returns empty for non-existent directory", async () => {
		const result = await importManualDirectory(
			join(EXAMPLES_RAW, "nonexistent"),
		);

		expect(result.transactions).toHaveLength(0);
		// readdirSync throws for non-existent dir, so we get an error
	});
});
