import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLES_RAW } from "./config.ts";
import type { SourceImportResult } from "./registry.ts";
import {
	deduplicateTransactions,
	findImporter,
	getImporterByName,
	importAllSources,
	importers,
	loadSourceConfig,
	matchByDirectoryName,
	matchByFileDetection,
} from "./registry.ts";
import { assertDefined } from "./test-utils.ts";

describe("registry", () => {
	describe("importers", () => {
		test("has fio importer", () => {
			const fio = importers.find((i) => i.name === "fio");
			expect(fio).toBeDefined();
			expect(fio?.directoryMatch).toBe("fio");
		});

		test("has revolut importer", () => {
			const revolut = importers.find((i) => i.name === "revolut");
			expect(revolut).toBeDefined();
			expect(revolut?.directoryMatch).toBe("revolut");
		});

		test("has ofx importer with detect function", () => {
			const ofx = importers.find((i) => i.name === "ofx");
			expect(ofx).toBeDefined();
			expect(ofx?.detect).toBeFunction();
		});

		test("ofx detect matches .ofx files", () => {
			const ofx = assertDefined(importers.find((i) => i.name === "ofx"));
			expect(ofx.detect?.(["foo.ofx"])).toBe(true);
			expect(ofx.detect?.(["FOO.OFX"])).toBe(true);
			expect(ofx.detect?.(["foo.json"])).toBe(false);
			expect(ofx.detect?.([])).toBe(false);
		});
	});

	describe("getImporterByName", () => {
		test("finds existing importer", () => {
			const fio = getImporterByName("fio");
			expect(fio?.name).toBe("fio");
		});

		test("returns undefined for unknown importer", () => {
			const unknown = getImporterByName("nonexistent");
			expect(unknown).toBeUndefined();
		});
	});

	describe("matchByDirectoryName", () => {
		test("matches fio directory", () => {
			const importer = matchByDirectoryName("fio");
			expect(importer?.name).toBe("fio");
		});

		test("matches case-insensitively", () => {
			const importer = matchByDirectoryName("FIO");
			expect(importer?.name).toBe("fio");
		});

		test("matches revolut directory", () => {
			const importer = matchByDirectoryName("revolut");
			expect(importer?.name).toBe("revolut");
		});

		test("matches fio-prefixed directories", () => {
			expect(matchByDirectoryName("fio-czk")?.name).toBe("fio");
			expect(matchByDirectoryName("fio-personal")?.name).toBe("fio");
			expect(matchByDirectoryName("fio-business")?.name).toBe("fio");
		});

		test("matches revolut-prefixed directories", () => {
			expect(matchByDirectoryName("revolut-personal")?.name).toBe("revolut");
			expect(matchByDirectoryName("revolut-business")?.name).toBe("revolut");
		});

		test("prefix match is case-insensitive", () => {
			expect(matchByDirectoryName("FIO-CZK")?.name).toBe("fio");
			expect(matchByDirectoryName("Revolut-Personal")?.name).toBe("revolut");
		});

		test("returns undefined for unknown directory", () => {
			const importer = matchByDirectoryName("unknown-bank");
			expect(importer).toBeUndefined();
		});

		test("does not match ofx by directory name", () => {
			// ofx importer uses detect, not directoryMatch
			const importer = matchByDirectoryName("ofx");
			expect(importer).toBeUndefined();
		});

		test("does not match partial names without hyphen", () => {
			// "fiobank" should not match "fio"
			expect(matchByDirectoryName("fiobank")).toBeUndefined();
			expect(matchByDirectoryName("revolutplus")).toBeUndefined();
		});
	});

	describe("matchByFileDetection", () => {
		const testDir = join(tmpdir(), "rummage-test-detection");

		beforeEach(() => {
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		test("detects ofx files", () => {
			writeFileSync(join(testDir, "test.ofx"), "");
			const importer = matchByFileDetection(testDir);
			expect(importer?.name).toBe("ofx");
		});

		test("returns undefined for empty directory", () => {
			const importer = matchByFileDetection(testDir);
			expect(importer).toBeUndefined();
		});

		test("returns undefined for unrecognized files", () => {
			writeFileSync(join(testDir, "test.txt"), "");
			writeFileSync(join(testDir, "test.pdf"), "");
			const importer = matchByFileDetection(testDir);
			expect(importer).toBeUndefined();
		});
	});

	describe("findImporter", () => {
		const testDir = join(tmpdir(), "rummage-test-find");

		beforeEach(() => {
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		test("uses config importer when specified", () => {
			const importer = findImporter("random-name", testDir, {
				importer: "fio",
			});
			expect(importer?.name).toBe("fio");
		});

		test("config importer takes precedence over directory name", () => {
			const importer = findImporter("revolut", testDir, { importer: "fio" });
			expect(importer?.name).toBe("fio");
		});

		test("falls back to directory name match", () => {
			const importer = findImporter("fio", testDir);
			expect(importer?.name).toBe("fio");
		});

		test("falls back to file detection", () => {
			writeFileSync(join(testDir, "data.ofx"), "");
			const importer = findImporter("my-checking", testDir);
			expect(importer?.name).toBe("ofx");
		});

		test("returns undefined when nothing matches", () => {
			const importer = findImporter("unknown", testDir);
			expect(importer).toBeUndefined();
		});

		test("returns undefined for invalid config importer", () => {
			const importer = findImporter("fio", testDir, {
				importer: "nonexistent",
			});
			expect(importer).toBeUndefined();
		});
	});

	describe("loadSourceConfig", () => {
		const testDir = join(tmpdir(), "rummage-test-config");

		beforeEach(() => {
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		test("returns undefined when no config exists", async () => {
			const config = await loadSourceConfig(testDir);
			expect(config).toBeUndefined();
		});

		test("loads config from rummage.ts", async () => {
			const configContent = `
				export const source = {
					importer: "fio",
					account: "Assets:Test",
				};
			`;
			writeFileSync(join(testDir, "rummage.ts"), configContent);

			const config = await loadSourceConfig(testDir);
			expect(config?.importer).toBe("fio");
			expect(config?.account).toBe("Assets:Test");
		});

		test("loads config with opening balance overrides", async () => {
			// Use unique directory to avoid module caching issues
			const uniqueDir = join(
				tmpdir(),
				`rummage-test-config-${Date.now()}-${Math.random()}`,
			);
			mkdirSync(uniqueDir, { recursive: true });

			const configContent = `
				export const source = {
					importer: "revolut",
					accountBase: "Assets:Revolut",
					openingBalance: {
						date: "2018-07-12",
						balances: {
							GBP: 564.76,
							PLN: -193.33,
						},
					},
				};
			`;
			writeFileSync(join(uniqueDir, "rummage.ts"), configContent);

			const config = await loadSourceConfig(uniqueDir);

			rmSync(uniqueDir, { recursive: true, force: true });

			expect(config?.openingBalance?.date).toBe("2018-07-12");
			expect(config?.openingBalance?.balances.GBP).toBe(564.76);
			expect(config?.openingBalance?.balances.PLN).toBe(-193.33);
		});
	});

	describe("importAllSources", () => {
		const testDir = join(tmpdir(), "rummage-test-import");

		beforeEach(() => {
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		test("returns empty results for non-existent path", async () => {
			const result = await importAllSources("/nonexistent/path");
			expect(result.results).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.warnings).toEqual([]);
		});

		test("skips underscore-prefixed directories", async () => {
			mkdirSync(join(testDir, "_archive"), { recursive: true });
			mkdirSync(join(testDir, "_statements"), { recursive: true });

			const result = await importAllSources(testDir);
			expect(result.skipped).toContain("_archive");
			expect(result.skipped).toContain("_statements");
			expect(result.results).toEqual([]);
		});

		test("skips files (only processes directories)", async () => {
			writeFileSync(join(testDir, "README.md"), "# Test");

			const result = await importAllSources(testDir);
			expect(result.results).toEqual([]);
			expect(result.skipped).toEqual([]);
		});

		test("warns for directories without matching importer", async () => {
			mkdirSync(join(testDir, "unknown-bank"), { recursive: true });

			const result = await importAllSources(testDir);
			expect(result.warnings).toContain(
				"No importer found for 'unknown-bank', skipping",
			);
		});

		test("skips directories with skip: true in config", async () => {
			const subDir = join(testDir, "skip-me");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(
				join(subDir, "rummage.ts"),
				"export const source = { skip: true };",
			);

			const result = await importAllSources(testDir);
			expect(result.skipped).toContain("skip-me");
		});

		test("imports from directory matching bank name", async () => {
			// Use real examples/raw/fio directory for integration test
			const result = await importAllSources(EXAMPLES_RAW);

			const fioResult = result.results.find((r) => r.name === "fio");
			expect(fioResult).toBeDefined();
			expect(fioResult?.importer).toBe("fio");
			expect(fioResult?.transactions.length).toBeGreaterThan(0);
		});

		test("passes options to importers", async () => {
			const result = await importAllSources(EXAMPLES_RAW, {
				accountMapping: {
					"1234567890": { account: "Assets:Test:Checking", currency: "CZK" },
				},
			});

			const fioResult = result.results.find((r) => r.name === "fio");
			expect(fioResult).toBeDefined();
			// Transactions should use the mapped account
			const mapped = fioResult?.transactions.find(
				(t) => t.account === "Assets:Test:Checking",
			);
			expect(mapped).toBeDefined();
		});

		test("returns duplicatesRemoved count", async () => {
			const result = await importAllSources(EXAMPLES_RAW);

			// Should have a duplicatesRemoved property (even if 0)
			expect(result.duplicatesRemoved).toBeNumber();
		});
	});

	describe("deduplicateTransactions", () => {
		const createTransaction = (id: string, account: string) => ({
			id,
			date: "2025-01-01",
			amount: { value: 100, currency: "USD" },
			description: "Test",
			account,
			source: "test.ofx",
		});

		test("removes duplicate transactions by ID", () => {
			const results: SourceImportResult[] = [
				{
					name: "source1",
					importer: "ofx",
					transactions: [
						createTransaction("txn-1", "Assets:Bank1"),
						createTransaction("txn-2", "Assets:Bank1"),
					],
					errors: [],
				},
				{
					name: "source2",
					importer: "ofx",
					transactions: [
						createTransaction("txn-1", "Assets:Bank2"), // duplicate
						createTransaction("txn-3", "Assets:Bank2"),
					],
					errors: [],
				},
			];

			const { results: deduped, duplicatesRemoved } =
				deduplicateTransactions(results);

			expect(duplicatesRemoved).toBe(1);
			expect(deduped[0]?.transactions).toHaveLength(2);
			expect(deduped[1]?.transactions).toHaveLength(1);
			expect(deduped[1]?.transactions[0]?.id).toBe("txn-3");
		});

		test("keeps first occurrence of duplicate", () => {
			const results: SourceImportResult[] = [
				{
					name: "source1",
					importer: "ofx",
					transactions: [createTransaction("txn-1", "Assets:Bank1")],
					errors: [],
				},
				{
					name: "source2",
					importer: "ofx",
					transactions: [createTransaction("txn-1", "Assets:Bank2")],
					errors: [],
				},
			];

			const { results: deduped } = deduplicateTransactions(results);

			// First source keeps the transaction
			expect(deduped[0]?.transactions).toHaveLength(1);
			expect(deduped[0]?.transactions[0]?.account).toBe("Assets:Bank1");
			// Second source has it removed
			expect(deduped[1]?.transactions).toHaveLength(0);
		});

		test("handles no duplicates", () => {
			const results: SourceImportResult[] = [
				{
					name: "source1",
					importer: "ofx",
					transactions: [
						createTransaction("txn-1", "Assets:Bank1"),
						createTransaction("txn-2", "Assets:Bank1"),
					],
					errors: [],
				},
			];

			const { results: deduped, duplicatesRemoved } =
				deduplicateTransactions(results);

			expect(duplicatesRemoved).toBe(0);
			expect(deduped[0]?.transactions).toHaveLength(2);
		});

		test("handles empty results", () => {
			const { results: deduped, duplicatesRemoved } = deduplicateTransactions(
				[],
			);

			expect(duplicatesRemoved).toBe(0);
			expect(deduped).toEqual([]);
		});
	});
});
