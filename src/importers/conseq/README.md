# Conseq Importer

Imports investment data from [Conseq](https://www.conseq.cz/) portal exports.

## Expected files

Place these in a `conseq/` directory under `raw/`:

| File pattern | Description |
|---|---|
| `*_SHARES.xlsx` | Share purchases — trade/settlement dates, unit counts, NAV prices, ISIN |
| `*_CASH.xlsx` | Cash account movements — deposits, entry fees, purchase debits, rounding |
| `*_account.xlsx` | Current holdings snapshot (optional, used for balance assertions) |

Export these from the Conseq portal under your contract. The filenames are
typically prefixed with the contract number (e.g., `4140729193_SHARES.xlsx`).

## What it produces

- **Commodity transactions**: Each share purchase becomes a Transaction with a
  `commodity` field — units at cost, debiting the cash account.
- **Commodity definition**: Symbol derived from fund name, with ISIN from the data.
- **Price directives**: NAV at each purchase date.
- **Balance assertions**: Unit count and cash balance from the account snapshot.
- **Fee transaction**: Entry fee extracted from the cash movements.
- **Rounding adjustments**: Small sub-cent corrections from Conseq's rounding.

Fund details (name, ISIN, commodity symbol) are read from the xlsx data,
not hardcoded.

## Configuration

Optional `ConseqConfig` for custom account paths:

```ts
{
  commoditySymbol?: string;   // default: derived from fund name
  fundAccount?: string;       // default: Assets:Investments:Conseq
  cashAccount?: string;       // default: Assets:Investments:Conseq:Cash
  feeAccount?: string;        // default: Expenses:Finance:Investments:Fees
  roundingAccount?: string;   // default: Income:Investments:Conseq:Rounding
}
```

## Data refresh

Export new files from the Conseq portal, replace the xlsx files, and rebuild.
The importer re-reads everything from scratch on each build.
