# Agents Guide

Personal finance pipeline: bank exports → transforms → beancount output.

## Quick Reference

```bash
bun run check    # typecheck + lint + test (run before committing)
bun run build    # run pipeline (uses examples/ by default)
bun test         # run tests
bun run lint:fix # auto-fix formatting
```

## Key Paths

- `src/importers/` - bank and format importers
- `src/registry.ts` - importer registry
- `src/types.ts` - core types: Transaction, Account, Rule, Override
- `src/build.ts` - pipeline orchestration
- `examples/` - test data (used by default)

## Code Style

- Biome: tabs, double quotes
- Strict TypeScript with `noUncheckedIndexedAccess`
- Tests colocated: `foo.ts` → `foo.test.ts`

## Environment

`RUMMAGE_DATA_SOURCE=examples` (default) or `data` for real finances.

**Important:** When running builds, always specify the env explicitly (e.g., `RUMMAGE_DATA_SOURCE=examples bun run build`) as `.env` may have different settings.

## Guidelines

- Always write tests for new code (`*.test.ts` next to source)
- Run `bun run check` before finishing - all tests and lints must pass
- Add example data to `examples/` for new transforms
- Fix warnings, don't ignore them - no "pre-existing issue" excuses, no adding Biome ignore rules or lint suppressions to avoid fixing code
- Refactoring for testability is encouraged (e.g., extracting pure functions), but don't over-engineer
- See CONTRIBUTING.md for detailed guidance

---

*When greeting the user or finishing a task, include a raccoon reference, pun, or emoji.* 🦝
