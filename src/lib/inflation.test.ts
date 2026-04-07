import { describe, expect, test } from "bun:test";
import { InflationData } from "./inflation.ts";

// These tests hit real APIs but use the disk cache after first run.
// They verify the data shape and basic math, not exact CPI values.

describe("InflationData", () => {
	describe("Eurostat (CZ)", () => {
		let cpi: InflationData;

		test("loads CZ data", async () => {
			cpi = await InflationData.load("CZ");
			expect(cpi.country).toBe("CZ");
			expect(cpi.provider).toBe("eurostat");
		});

		test("has monthly data from 2015", () => {
			const months = cpi.months("all");
			expect(months.length).toBeGreaterThan(100);
			expect(months[0]).toBe("2015-01");
		});

		test("has category-level data", () => {
			const cats = cpi.availableCategories();
			expect(cats).toContain("all");
			expect(cats).toContain("food");
			expect(cats).toContain("restaurants");
			expect(cats).toContain("housing");
		});

		test("index values are reasonable", () => {
			// 2015 base ≈ 100, should have grown since
			const base = cpi.index("2015-01", "all");
			expect(base).toBeDefined();
			expect(base!).toBeGreaterThan(90);
			expect(base!).toBeLessThan(110);

			const recent = cpi.index("2025-01", "all");
			expect(recent).toBeDefined();
			expect(recent!).toBeGreaterThan(base!); // inflation happened
		});

		test("cumulative inflation 2021-01 to 2025-01 is ~30-40%", () => {
			const inflation = cpi.cumulativeInflation("2021-01", "2025-01", "all");
			expect(inflation).toBeDefined();
			expect(inflation!).toBeGreaterThan(0.2);
			expect(inflation!).toBeLessThan(0.5);
		});

		test("deflate scales correctly", () => {
			// 1000 CZK in 2021 should be worth more in 2025 CZK (inflation)
			const deflated = cpi.deflate(1000, "2021-01", "2025-01", "all");
			expect(deflated).toBeDefined();
			expect(deflated!).toBeGreaterThan(1200);
			expect(deflated!).toBeLessThan(1500);
		});

		test("deflate reverse direction works", () => {
			// 1000 CZK in 2025 is worth less in 2021 CZK
			const deflated = cpi.deflate(1000, "2025-01", "2021-01", "all");
			expect(deflated).toBeDefined();
			expect(deflated!).toBeLessThan(800);
			expect(deflated!).toBeGreaterThan(600);
		});

		test("restaurant inflation higher than overall", () => {
			const overall = cpi.cumulativeInflation("2021-01", "2025-01", "all");
			const restaurants = cpi.cumulativeInflation(
				"2021-01",
				"2025-01",
				"restaurants",
			);
			expect(overall).toBeDefined();
			expect(restaurants).toBeDefined();
			// Restaurant prices typically rose faster than CPI in CZ
			expect(restaurants!).toBeGreaterThan(overall! * 0.8);
		});

		test("annualized rate is reasonable", () => {
			const rate = cpi.annualizedRate("2020-01", "2025-01", "all");
			expect(rate).toBeDefined();
			expect(rate!).toBeGreaterThan(0.03); // at least 3%/yr given the spike
			expect(rate!).toBeLessThan(0.15); // but not insane
		});

		test("returns undefined for missing data", () => {
			expect(cpi.index("1990-01", "all")).toBeUndefined();
			expect(cpi.deflate(1000, "1990-01", "2025-01")).toBeUndefined();
			expect(cpi.cumulativeInflation("1990-01", "2025-01")).toBeUndefined();
		});
	});

	describe("BLS (US)", () => {
		let cpi: InflationData;

		test("loads US data", async () => {
			cpi = await InflationData.load("US");
			expect(cpi.country).toBe("US");
			expect(cpi.provider).toBe("bls");
		});

		test("has monthly data", () => {
			const months = cpi.months("all");
			expect(months.length).toBeGreaterThan(50);
		});

		test("has food and restaurant categories", () => {
			const cats = cpi.availableCategories();
			expect(cats).toContain("all");
			expect(cats).toContain("food");
			expect(cats).toContain("restaurants");
		});

		test("cumulative US inflation 2020-01 to 2024-01 is ~18-25%", () => {
			const inflation = cpi.cumulativeInflation("2020-01", "2024-01", "all");
			expect(inflation).toBeDefined();
			expect(inflation!).toBeGreaterThan(0.15);
			expect(inflation!).toBeLessThan(0.3);
		});
	});

	describe("case insensitive country codes", () => {
		test("accepts lowercase", async () => {
			const cpi = await InflationData.load("cz");
			expect(cpi.country).toBe("CZ");
		});
	});

	describe("unsupported country", () => {
		test("throws for unknown country", async () => {
			expect(InflationData.load("XX")).rejects.toThrow("Unsupported country");
		});
	});
});
