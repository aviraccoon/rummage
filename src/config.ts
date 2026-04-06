/**
 * Configuration - controls data source via environment variable.
 *
 * RUMMAGE_DATA_SOURCE=examples           → use examples/ (default, for tests)
 * RUMMAGE_DATA_SOURCE=/path/to/finances  → use an external directory
 *
 * Any value other than "examples" is treated as a path (resolved relative to
 * the project root if not absolute).
 */

import { isAbsolute, join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const EXAMPLES_PATH = join(ROOT, "examples");
export const EXAMPLES_RAW = join(EXAMPLES_PATH, "raw");

const dataSource = process.env.RUMMAGE_DATA_SOURCE || "examples";

export const DATA_PATH =
	dataSource === "examples"
		? EXAMPLES_PATH
		: isAbsolute(dataSource)
			? dataSource
			: join(ROOT, dataSource);

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
