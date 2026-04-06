# Revolut

See [API.md](API.md) for documentation of the internal web app API endpoints,
transaction object shape, and known quirks.

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

### What's fetched

The script calls Revolut's internal web app API (`/api/retail/user/current/transactions/last`).
This is **not** the official Open Banking or Business API — it's the same endpoint the
web app uses. Auth comes from your browser session.

Each currency pocket is fetched separately. The response includes vault/savings
transactions and exchange legs involving other currencies.

## Files

- `{CUR}_{YEAR}.json` - Transaction data per currency per year
- `_statements/` - PDF statements for archival (underscore prefix = ignored by importer)

## Downloading statements (optional)

1. Go to https://app.revolut.com → Documents → Account statements
2. Select currency and date range
3. Download PDF
4. Save to `_statements/`

## Vault/Savings transactions

Vault transfers (Savings Vaults, Flexible Cash Funds, spare change round-ups)
appear as two legs: a CURRENT leg (outflow) and a SAVINGS leg (inflow), or
vice versa. Both are imported and net to zero on the account.

The `vault` field on the transaction object identifies vault movements.
`account.type` distinguishes `CURRENT` from `SAVINGS` — the `balance` field
reflects whichever account type the transaction belongs to. Balance assertions
filter out SAVINGS transactions to avoid using vault balances.

See [API.md](API.md) for details on the transaction shape.

## Pending transactions

Transactions with `state: "PENDING"` are authorized but not settled. They have
no `balance` or `completedDate`. They're imported but don't affect balance
assertions (which are derived from the latest completed transaction's balance).

## Closed currency accounts

Revolut's exports don't include complete transaction history for closed or
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
