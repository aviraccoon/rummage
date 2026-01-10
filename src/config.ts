/**
 * Configuration - controls data source via environment variable.
 *
 * RUMMAGE_DATA_SOURCE=examples  → use examples/ (default, for tests)
 * RUMMAGE_DATA_SOURCE=data      → use data/ (your real finances)
 */

import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const EXAMPLES_PATH = join(ROOT, "examples");
export const EXAMPLES_RAW = join(EXAMPLES_PATH, "raw");

type DataSource = "examples" | "data";

const dataSource: DataSource =
	(process.env.RUMMAGE_DATA_SOURCE as DataSource) || "examples";

export const DATA_PATH = join(ROOT, dataSource);

export const config = {
	/** Which data source is being used */
	dataSource,

	/** Path to raw bank exports */
	rawPath: join(DATA_PATH, "raw"),

	/** Path to categorization rules */
	rulesPath: join(DATA_PATH, "rules.ts"),

	/** Path to account definitions */
	accountsPath: join(DATA_PATH, "accounts.ts"),

	/** Path to payee locations */
	locationsPath: join(DATA_PATH, "locations.ts"),

	/** Path to generated output (inside data source dir) */
	generatedPath: join(DATA_PATH, "generated"),

	/** Whether using example data */
	isUsingExamples: dataSource === "examples",
};
