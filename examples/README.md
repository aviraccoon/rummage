# Example Data

Sample data that works out of the box. Copy this structure to `data/` for your real finances.

## Structure

```
examples/
├── raw/                    # Bank exports (auto-discovered)
│   ├── fio/                # Fio banka (.ofx, .json)
│   ├── revolut/            # Revolut ({CUR}_{YEAR}.json)
│   ├── ofx/                # Generic OFX files
│   └── manual/             # Manual transactions (TypeScript)
├── rules.ts                # Categorization rules
├── categories.ts           # Category hierarchy
├── accounts.ts             # Account definitions
├── overrides.ts            # Global transaction corrections
├── locations.ts            # Location mappings
└── generated/              # Pipeline output
```

## Bank Directories

Each subdirectory in `raw/` is auto-discovered by name or file patterns. Directories starting with `_` are skipped.

Add a `rummage.ts` config file to customize behavior:

```typescript
import type { SourceConfig } from "../../../src/importers/types.ts";

export const source: SourceConfig = {
  importer: "ofx",             // Force specific importer
  accountBase: "Assets:MyBank", // Override account prefix
  // skip: true,                // Ignore this directory
};
```

## Per-Source Overrides

Add `{filename}.overrides.ts` next to any import file:

```typescript
import type { Override } from "../../../src/types.ts";

export const overrides: Override[] = [
  { id: "fio-12345", category: "Expenses:Food" },
];
```
