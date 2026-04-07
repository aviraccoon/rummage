# Amundi CR Importer

Imports investment data from Amundi Czech Republic's API (moje.amundi.com/cz).
See [API.md](API.md) for endpoint documentation and data shapes.

## Data Flow

1. **Fetch**: Authenticate via Keycloak, download orders → trades → save as JSON
2. **Import**: Read `trades.json`, generate commodity transactions for beancount

The bank-side deposits (e.g., monthly contributions from a bank account) are
tracked by the bank's importer and categorized via rules to point at the Amundi
cash account. This importer handles what happens inside Amundi: cash → fund units.

## Files

- `api.ts` — API types and HTTP client (Keycloak auth + paginated endpoints)
- `fetch.ts` — CLI for downloading data to `raw/amundi/`
- `transform.ts` — Importer: reads saved JSON, produces commodity transactions

## Saved Data Format

The fetch script saves these files to `raw/amundi/`:

- `trades.json` — `AmundiTrade[]` — executed trades with NAV, units, amounts
- `orders.json` — `AmundiOrder[]` — orders (for entry fee calculation)
- `funds.json` — `AmundiFund[]` — fund metadata (ISIN, name, fees)
- `cashflow.json` — `AmundiCashflow[]` — cash movements (for reference)

Only `trades.json` is required. With `orders.json`, the importer also generates
entry fee and rounding transactions.

## Usage

### Fetching Data

```bash
# With credentials in .env (or injected via 1Password):
bun run src/importers/amundi/fetch.ts

# Step-by-step mode (pauses between API calls):
bun run src/importers/amundi/fetch.ts --step
```

Authentication is interactive: choose between stored credentials
(`AMUNDI_USERNAME`/`AMUNDI_PASSWORD` from env) or pasting a Bearer token
from browser devtools. Contract is auto-detected from the API.

### Building

Once data is saved, `bun run build` picks it up automatically via the
`amundi` directory name in `raw/`.

## Account Structure

```
Assets:Investments:Amundi       — fund units (commodity postings)
Assets:Investments:Amundi:Cash  — CZK cash in Amundi account
```

When `orders.json` is present, entry fees and rounding are tracked explicitly.
Without it, only commodity purchases are generated and rounding residuals
accumulate naturally in the cash account.

## Configuration

The importer accepts `AmundiConfig` for customization:

```typescript
{
  fundAccount: "Assets:Investments:Amundi",      // where units are held
  cashAccount: "Assets:Investments:Amundi:Cash",  // internal cash account
  commoditySymbols: {                             // override derived symbols
    "CZ0008474517": "AMSTAR",
  },
}
```

Commodity symbols are derived from fund names by default (stripping "Amundi CR"
prefix and "class X" suffix, then abbreviating). Override via `commoditySymbols`
for cleaner symbols.
