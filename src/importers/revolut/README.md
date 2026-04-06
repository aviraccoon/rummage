# Revolut

## Fetching transactions

```bash
bun run src/importers/revolut/fetch.ts                 # saves to raw/revolut/
bun run src/importers/revolut/fetch.ts --name personal # saves to raw/revolut-personal/
```

1. Go to https://app.revolut.com and log in
2. Click "See all" transactions for the currency you want
3. Open DevTools (F12) → Network tab
4. Find the request to `transactions/last`
5. Right-click → Copy → Copy as cURL
6. Paste into the CLI when prompted

Use `--name` to create separate directories for multiple Revolut accounts.
Repeat for each currency (USD, EUR, CZK) within each account.

Only authentication data is extracted from the cURL — URL parameters are ignored.
The script always fetches all transactions from newest to oldest, then deduplicates
against existing files by transaction ID. Safe to re-run anytime.

## Files

- `{CUR}_{YEAR}.json` - Transaction data per currency per year
- `_statements/` - PDF statements for archival (underscore prefix = ignored by importer)

## Downloading statements (optional)

1. Go to https://app.revolut.com → Documents → Account statements
2. Select currency and date range
3. Download PDF
4. Save to `_statements/`

## Closed currency accounts

Revolut's API exports don't include complete transaction history for closed or
inactive currency accounts. If you previously held a currency (e.g., GBP) but
closed it, the export may be missing earlier transactions.

**Symptoms:** Balance assertions fail for currencies you no longer use, showing
large discrepancies.

**Solution:** Specify opening balances manually in `rummage.ts`:

```typescript
export const source: SourceConfig = {
  importer: "revolut",
  openingBalance: {
    date: "2018-07-12", // Date of first transaction you have
    balances: {
      GBP: 564.76, // Calculated: expected_final - net_of_known_transactions
      PLN: -193.33,
    },
  },
};
```

Calculate the needed opening balance:
1. Find the expected final balance from the last transaction's `balance` field
2. Sum all transactions you have for that currency
3. Opening = expected_final - sum_of_transactions
