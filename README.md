# rummage 🦝

```
    /\_/\
   ( o.o )  *rummages through your finances*
    > ^ <
   /|   |\
  (_|   |_)
```

Plain-text finance tracking. Rummage through your transactions like a raccoon through trash—find the good stuff, spot the problems, know where everything went.

## What This Is

A pipeline that transforms raw bank exports into queryable financial data:

```
bank exports → transforms → your data → beancount/reports
     📄            🦝           💰            📊
```

- **Tracking, not budgeting** - see where money went, don't enforce limits
- **Own your data** - plain text, version controlled, LLM-queryable
- **Extensible** - add transforms for your banks, custom reports, API later

> *rummage (v.)*: to inspect financial data for irregularities, hidden opportunities, or risks—like customs officials inspecting cargo. Also what raccoons do. 🦝

## Prerequisites

### With Nix (recommended)

If you have Nix with flakes enabled:

```bash
# Enter dev shell (provides bun, beancount, fava)
nix develop

# Or use direnv for automatic activation
direnv allow
```

### Without Nix

Install separately:

```bash
# Bun (JS runtime)
mise install        # or: curl -fsSL https://bun.sh/install | bash

# Beancount + Fava (Python)
uv tool install beancount fava
# or: pipx install beancount fava
```

## Quick Start

```bash
git clone https://github.com/aviraccoon/rummage
cd rummage

bun install

# Rummage through example data
bun run build

# Validate the ledger
bean-check examples/generated/main.beancount

# View in Fava (http://localhost:5000)
fava examples/generated/main.beancount
```

Works out of the box with examples.

## Structure

```
rummage/
├── examples/            # Sample data (works out of the box)
│   ├── raw/             # Bank exports
│   │   ├── fio/         # Fio banka exports
│   │   ├── revolut/     # Revolut exports
│   │   ├── ofx/         # Generic OFX files
│   │   └── manual/      # Manual entries
│   ├── generated/       # Output (main.beancount)
│   ├── accounts.ts      # Account definitions
│   ├── categories.ts    # Category hierarchy
│   ├── locations.ts     # Payee locations
│   ├── overrides.ts     # Transaction corrections
│   └── rules.ts         # Categorization patterns
├── data/                # Your real data (gitignored, same structure)
├── src/                 # Source code
└── scripts/             # Custom reports
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for source code structure.

## Using Your Own Data

1. Create `data/` directory (gitignored)
2. Copy structure from `examples/`
3. Add your bank exports to `data/raw/`
4. Customize `data/rules.ts` with your patterns
5. Rummage:

```bash
RUMMAGE_DATA_SOURCE=data bun run build
```

Or create `.env`:
```
RUMMAGE_DATA_SOURCE=data
```

Default is `examples` - safe for tests and new users.

## API Tokens

Some importers (like Fio) need API tokens. Each Fio account needs its own token.

**Simple approach** - create `.env` (gitignored):
```
FIO_TOKEN_PERSONAL=your-64-character-token
FIO_TOKEN_BUSINESS=another-token
```

**Password manager approach** - create `mise.local.toml` (gitignored):
```toml
[tasks.1p]
run = "op run --account my.1password.com --env-file .env --"
raw = true
```

Then use `op://` references in `.env`:
```
FIO_TOKEN_PERSONAL=op://Private/Fio/personal
FIO_TOKEN_BUSINESS=op://Private/Fio/business
```

Run with: `mise 1p bun run build`

Works with 1Password, Bitwarden, or any tool that injects env vars.

## Features

- **Multi-currency** - handles conversions, preserves original amounts
- **Split transactions** - one purchase, multiple categories
- **Payee locations** - geographic spending data
- **Recurring detection** - find subscriptions automatically
- **Balance assertions** - verify against bank statements
- **Override system** - fix categorization without editing raw data

## What You'll Find 🦝

Like a raccoon finding treasures:

- 🗑️ Forgotten subscriptions
- 💸 Where money actually goes
- 📈 Net worth over time
- 🔄 Recurring patterns
- 🗺️ Geographic spending
- ⚠️ Anomalies and surprises

## Future

- HTTP API for mobile/LLM access
- Custom dashboards beyond Fava
- Threshold alerts

## Tech Stack

- Bun + TypeScript
- Beancount (output format)
- Fava (web UI)

### Beancount CLI Tools

```bash
bean-check ledger.beancount    # Validate ledger
bean-query ledger.beancount    # Query transactions (SQL-like)
bean-format ledger.beancount   # Format/prettify
fava ledger.beancount          # Web UI at localhost:5000
```

## Contributing

Want to add support for your bank? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT - do whatever you want with the code.

Your financial data stays yours. Happy rummaging! 🦝
