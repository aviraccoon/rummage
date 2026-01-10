/**
 * Example source configuration.
 *
 * This file is optional - without it, the importer is auto-detected
 * from files present (.ofx → ofx importer) and accounts use conventions.
 */

import type { SourceConfig } from "../../../src/importers/types.ts";

export const source: SourceConfig = {
	// Override account base - transactions will use "Assets:OtherBank:{currency}"
	// instead of the auto-generated "Assets:Bank-{bankId}:{currency}"
	accountBase: "Assets:OtherBank",
};
