/**
 * Inflation data fetcher and deflation calculator.
 *
 * Fetches CPI index data from public APIs:
 * - Eurostat HICP: EU/EEA countries + UK, Switzerland, candidates (~40 countries)
 * - BLS CPI-U: United States
 *
 * Caches fetched data to disk to avoid repeated API calls.
 *
 * Usage:
 *   const cpi = await InflationData.load("CZ");
 *   const real = cpi.deflate(1000, "2022-01", "2026-01"); // 1000 CZK in Jan 2022 → Jan 2026 CZK
 *   const factor = cpi.cumulativeInflation("2021-01", "2026-01"); // e.g. 0.35 = 35%
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ──

/** Year-month string: "2024-03" */
export type YearMonth = string;

/** Monthly CPI index values keyed by YYYY-MM */
export type CPIIndex = Record<YearMonth, number>;

/** Category codes that map across providers */
export type CPICategory =
	| "all" // Overall CPI
	| "food" // Food & non-alcoholic beverages
	| "restaurants" // Restaurants & hotels / food away from home
	| "housing" // Housing, electricity, gas, fuels
	| "transport" // Transport
	| "health" // Health
	| "clothing" // Clothing & footwear
	| "recreation" // Recreation & culture
	| "communication"; // Communications

interface CPICacheFile {
	provider: string;
	country: string;
	fetchedAt: string;
	categories: Record<string, CPIIndex>;
}

// ── Provider mappings ──

/** Eurostat COICOP codes */
const EUROSTAT_CATEGORIES: Record<CPICategory, string> = {
	all: "CP00",
	food: "CP01",
	restaurants: "CP11",
	housing: "CP04",
	transport: "CP07",
	health: "CP06",
	clothing: "CP03",
	recreation: "CP09",
	communication: "CP08",
};

/** BLS series IDs (CPI-U, US city average, not seasonally adjusted) */
const BLS_CATEGORIES: Record<CPICategory, string> = {
	all: "CUUR0000SA0",
	food: "CUUR0000SAF1",
	restaurants: "CUUR0000SEFV", // Food away from home
	housing: "CUUR0000SAH",
	transport: "CUUR0000SAT",
	health: "CUUR0000SAM",
	clothing: "CUUR0000SAA",
	recreation: "CUUR0000SAR",
	communication: "CUUR0000SAE2",
};

/** ISO country codes → provider */
type Provider = "eurostat" | "bls";

// Eurostat geo codes (subset — full list is ~40 countries)
const EUROSTAT_COUNTRIES = new Set([
	"AT",
	"BE",
	"BG",
	"CH",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"EL",
	"ES",
	"FI",
	"FR",
	"HR",
	"HU",
	"IE",
	"IS",
	"IT",
	"LT",
	"LU",
	"LV",
	"ME",
	"MK",
	"MT",
	"NL",
	"NO",
	"PL",
	"PT",
	"RO",
	"RS",
	"SE",
	"SI",
	"SK",
	"TR",
	"UK",
]);

function getProvider(country: string): Provider {
	if (country === "US") return "bls";
	if (EUROSTAT_COUNTRIES.has(country)) return "eurostat";
	throw new Error(
		`Unsupported country: ${country}. Supported: US, ${[...EUROSTAT_COUNTRIES].sort().join(", ")}`,
	);
}

// ── Cache ──

const CACHE_DIR = join(
	process.env.HOME ?? "/tmp",
	".cache",
	"rummage",
	"inflation",
);
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCachePath(country: string): string {
	return join(CACHE_DIR, `${country.toLowerCase()}.json`);
}

function readCache(country: string): CPICacheFile | null {
	const path = getCachePath(country);
	if (!existsSync(path)) return null;

	try {
		const data: CPICacheFile = JSON.parse(readFileSync(path, "utf-8"));
		const age = Date.now() - new Date(data.fetchedAt).getTime();
		if (age > CACHE_MAX_AGE_MS) return null;
		return data;
	} catch {
		return null;
	}
}

function writeCache(data: CPICacheFile, country: string): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(getCachePath(country), JSON.stringify(data, null, 2));
}

// ── Eurostat fetcher ──

interface EurostatResponse {
	id: string[]; // dimension order, e.g. ["freq", "unit", "coicop", "geo", "time"]
	size: number[]; // size of each dimension
	dimension: Record<string, { category: { index: Record<string, number> } }>;
	value: Record<string, number>;
}

async function fetchEurostat(
	country: string,
): Promise<Record<string, CPIIndex>> {
	// Eurostat needs repeated params for multi-value, not comma-separated
	const coicopParams = Object.values(EUROSTAT_CATEGORIES)
		.map((c) => `coicop=${c}`)
		.join("&");
	const url =
		`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx` +
		`?format=JSON&lang=EN&unit=I15&geo=${country}&${coicopParams}&sinceTimePeriod=2015-01`;

	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`Eurostat API error: ${resp.status} ${resp.statusText}`);
	}

	const data = (await resp.json()) as EurostatResponse;

	// Eurostat packs values in a flat object with sequential string keys.
	// The key is computed from the multi-dimensional index:
	//   key = sum(dim_offset[i] * product(size[j] for j > i))
	// Dimensions are ordered as in data.id, e.g. ["freq", "unit", "coicop", "geo", "time"]

	const dimSizes = data.size;
	const dimNames = data.id;

	// Pre-compute stride for each dimension
	const strides: number[] = new Array(dimSizes.length).fill(1);
	for (let i = dimSizes.length - 2; i >= 0; i--) {
		strides[i] = (strides[i + 1] ?? 1) * (dimSizes[i + 1] ?? 1);
	}

	const coicopDimIdx = dimNames.indexOf("coicop");
	const timeDimIdx = dimNames.indexOf("time");
	if (coicopDimIdx < 0 || timeDimIdx < 0) {
		throw new Error("Eurostat response missing expected dimensions");
	}

	const coicopIndex = data.dimension.coicop?.category.index ?? {};
	const timeIndex = data.dimension.time?.category.index ?? {};

	// All other dimensions should have size 1 after filtering (freq=M, unit=I15, geo=country)
	// Their offset is 0.

	const result: Record<string, CPIIndex> = {};

	for (const [category, coicopCode] of Object.entries(EUROSTAT_CATEGORIES)) {
		const coicopOffset = coicopIndex[coicopCode];
		if (coicopOffset === undefined) continue;

		const index: CPIIndex = {};
		for (const [timePeriod, timeOffset] of Object.entries(timeIndex)) {
			// Compute flat key: only coicop and time dimensions have non-zero offsets
			const flatKey =
				coicopOffset * (strides[coicopDimIdx] ?? 1) +
				timeOffset * (strides[timeDimIdx] ?? 1);
			const val = data.value[String(flatKey)];
			if (val !== undefined && val !== null) {
				index[timePeriod] = val;
			}
		}
		result[category] = index;
	}

	return result;
}

// ── BLS fetcher ──

interface BLSResponse {
	status: string;
	Results: {
		series: Array<{
			seriesID: string;
			data: Array<{
				year: string;
				period: string;
				value: string;
			}>;
		}>;
	};
}

async function fetchBLS(): Promise<Record<string, CPIIndex>> {
	const result: Record<string, CPIIndex> = {};

	// BLS v2 public API: up to 25 series, 10 year range, no key needed
	// We need to split into two requests for the full range (2015-2026 = 12 years)
	const ranges = [
		{ start: 2015, end: 2024 },
		{ start: 2025, end: 2026 },
	];

	for (const range of ranges) {
		const seriesIds = Object.values(BLS_CATEGORIES);
		const body = JSON.stringify({
			seriesid: seriesIds,
			startyear: String(range.start),
			endyear: String(range.end),
		});

		const resp = await fetch(
			"https://api.bls.gov/publicAPI/v2/timeseries/data/",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			},
		);
		if (!resp.ok) {
			throw new Error(`BLS API error: ${resp.status} ${resp.statusText}`);
		}

		const data = (await resp.json()) as BLSResponse;
		if (data.status !== "REQUEST_SUCCEEDED") {
			throw new Error(`BLS API failed: ${data.status}`);
		}

		for (const series of data.Results.series) {
			// Find which category this series belongs to
			const category = Object.entries(BLS_CATEGORIES).find(
				([, id]) => id === series.seriesID,
			)?.[0];
			if (!category) continue;

			if (!result[category]) result[category] = {};

			for (const point of series.data) {
				// period is "M01" through "M12", skip annual averages ("M13")
				if (!point.period.startsWith("M") || point.period === "M13") continue;
				const val = Number.parseFloat(point.value);
				if (Number.isNaN(val) || point.value === "-") continue;

				const month = point.period.slice(1); // "01" from "M01"
				const ym = `${point.year}-${month}`;
				const cat = result[category];
				if (cat) cat[ym] = val;
			}
		}
	}

	return result;
}

// ── Public API ──

export class InflationData {
	private categories: Record<string, CPIIndex>;
	readonly country: string;
	readonly provider: string;

	private constructor(
		country: string,
		provider: string,
		categories: Record<string, CPIIndex>,
	) {
		this.country = country;
		this.provider = provider;
		this.categories = categories;
	}

	/**
	 * Load inflation data for a country.
	 * Uses disk cache (7-day TTL) to avoid redundant API calls.
	 */
	static async load(country: string): Promise<InflationData> {
		const cc = country.toUpperCase();
		const provider = getProvider(cc);

		// Try cache first
		const cached = readCache(cc);
		if (cached) {
			return new InflationData(cc, provider, cached.categories);
		}

		// Fetch fresh
		const categories =
			provider === "eurostat" ? await fetchEurostat(cc) : await fetchBLS();

		// Cache it
		writeCache(
			{
				provider,
				country: cc,
				fetchedAt: new Date().toISOString(),
				categories,
			},
			cc,
		);

		return new InflationData(cc, provider, categories);
	}

	/** Available year-months for a category, sorted. */
	months(category: CPICategory = "all"): YearMonth[] {
		const idx = this.categories[category];
		if (!idx) return [];
		return Object.keys(idx).sort();
	}

	/** Get CPI index value for a specific month and category. */
	index(ym: YearMonth, category: CPICategory = "all"): number | undefined {
		return this.categories[category]?.[ym];
	}

	/**
	 * Cumulative inflation between two months.
	 * Returns a fraction, e.g. 0.35 means prices rose 35%.
	 */
	cumulativeInflation(
		from: YearMonth,
		to: YearMonth,
		category: CPICategory = "all",
	): number | undefined {
		const fromIdx = this.index(from, category);
		const toIdx = this.index(to, category);
		if (fromIdx === undefined || toIdx === undefined) return undefined;
		return (toIdx - fromIdx) / fromIdx;
	}

	/**
	 * Deflate an amount from one period to another.
	 * "What is `amount` in `from` prices worth in `to` prices?"
	 *
	 * deflate(1000, "2022-01", "2026-01") → ~1350 (if 35% inflation)
	 * deflate(1000, "2026-01", "2022-01") → ~740  (reverse: today's money in 2022 terms)
	 */
	deflate(
		amount: number,
		from: YearMonth,
		to: YearMonth,
		category: CPICategory = "all",
	): number | undefined {
		const fromIdx = this.index(from, category);
		const toIdx = this.index(to, category);
		if (fromIdx === undefined || toIdx === undefined) return undefined;
		return amount * (toIdx / fromIdx);
	}

	/**
	 * Annualized inflation rate between two months.
	 * Returns a fraction, e.g. 0.05 means 5%/year.
	 */
	annualizedRate(
		from: YearMonth,
		to: YearMonth,
		category: CPICategory = "all",
	): number | undefined {
		const fromIdx = this.index(from, category);
		const toIdx = this.index(to, category);
		if (fromIdx === undefined || toIdx === undefined) return undefined;

		const [fromY, fromM] = from.split("-").map(Number) as [number, number];
		const [toY, toM] = to.split("-").map(Number) as [number, number];
		const years = toY - fromY + (toM - fromM) / 12;
		if (years <= 0) return undefined;

		return (toIdx / fromIdx) ** (1 / years) - 1;
	}

	/**
	 * Get all available categories with data.
	 */
	availableCategories(): CPICategory[] {
		return Object.keys(this.categories).filter(
			(k) => Object.keys(this.categories[k] ?? {}).length > 0,
		) as CPICategory[];
	}
}
