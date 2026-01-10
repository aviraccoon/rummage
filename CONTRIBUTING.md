# Contributing to rummage 🦝

```
    /\_/\
   ( ^.^ )  *excited chittering*
    > ^ <
```

Want to help rummage through finances? Here's how to get your paws dirty.

## Getting Started

```bash
# Clone and enter the den
git clone https://github.com/aviraccoon/rummage
cd rummage

# Option 1: Nix (recommended) - provides bun, beancount, fava
nix develop
# Or with direnv: direnv allow

# Option 2: Manual setup
mise install                      # bun
uv tool install beancount fava    # beancount tooling

# Install dependencies
bun install

# Make sure everything works
bun run check
```

## Development Workflow

```bash
# Run the build pipeline
# Always specify env explicitly (don't rely on .env which may have different settings)
RUMMAGE_DATA_SOURCE=examples bun run build

# Run tests
bun test

# Run everything (typecheck + lint + test)
bun run check

# Fix linting issues
bun run lint:fix

# Typecheck only
bun run typecheck
```

## Code Style

We use **Biome** for linting and formatting:

- Tabs for indentation
- Double quotes for strings
- No trailing semicolons required (Biome handles it)

Run `bun run lint:fix` before committing. The raccoon will be sad if CI fails.

## Project Structure

```
src/
├── importers/      # Bank and format importers
├── output/         # Output generators (beancount, etc.)
├── types.ts        # Core data structures
├── config.ts       # Environment configuration
├── registry.ts     # Importer registry
├── build.ts        # Pipeline orchestration
└── *.test.ts       # Tests live next to source files
```

## Adding a Bank Transform

This is the most common contribution! To add support for a new bank:

1. **Create the bank directory** `src/importers/your-bank/` with:
   - `transform.ts` - the importer logic
   - `transform.test.ts` - tests

```typescript
// src/importers/your-bank/transform.ts
import type { ImportResult, Transaction } from "../../types.ts";

export function importYourBankFile(filePath: string): ImportResult {
  // Parse CSV/OFX/whatever format your bank uses
  // Return { transactions, errors }
}

export function importYourBankDirectory(dirPath: string): ImportResult {
  // Import all files from a directory
}
```

2. **Add tests** in `src/importers/your-bank/transform.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { importYourBankFile } from "./transform.ts";

describe("importYourBankFile", () => {
  test("parses transactions correctly", () => {
    // Add sample file to examples/raw/your-bank/
    const result = importYourBankFile("examples/raw/your-bank/sample.csv");
    expect(result.transactions).toHaveLength(/* expected */);
  });
});
```

3. **Register the importer** in `src/registry.ts` (follow the pattern for `fio` and `revolut`)

4. **Add example data** in `examples/raw/your-bank/` with sanitized sample exports

### Transform Guidelines

- Generate **stable, unique IDs** (for override matching and deduplication)
- Preserve **rawName** and **rawMemo** for rule matching
- Use ISO dates: `YYYY-MM-DD`
- Positive amounts = inflow, negative = outflow
- Set `source` to the file path

## Testing

Tests use Bun's built-in test runner:

```bash
# Run all tests
bun test

# Run specific test file
bun test src/importers/ofx.test.ts

# Watch mode
bun test --watch
```

Tests run against `examples/` data by default. Add sample files there for new features.

## TypeScript

We use strict TypeScript:

- `strict: true`
- `noUncheckedIndexedAccess: true` (array access returns `T | undefined`)
- Use `assertAt()` and `assertDefined()` from `test-utils.ts` in tests

## Code Philosophy

- **Fix warnings, don't suppress them** - no `biome-ignore` or lint disables to sweep issues under the rug
- **Refactoring for testability is encouraged** - extracting pure functions, breaking up complexity - just don't over-engineer

## Pull Requests

1. Fork and create a branch
2. Make your changes
3. Run `bun run check` (must pass!)
4. Write/update tests
5. Submit PR with clear description

### PR Checklist

- [ ] `bun run check` passes
- [ ] Tests added/updated
- [ ] Example data added (if new transform)
- [ ] `CHANGELOG.md` updated (for notable changes)
- [ ] Version bumped in `package.json` (for releases)

## What We're Looking For 🗑️

Like a raccoon looking for treasures:

- **New bank transforms** - support more banks/formats
- **Bug fixes** - especially in parsing edge cases
- **Output formats** - beyond Beancount
- **Scripts** - useful financial analysis tools

## Questions?

Open an issue! We don't bite (unless you're a garbage bag full of transactions).

```
    /\_/\
   ( o.o )  Happy rummaging!
    > ^ <
   /|   |\
```
