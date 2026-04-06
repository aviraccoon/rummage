# Revolut Internal Web App API

Undocumented API used by Revolut's web app at `app.revolut.com`. This is **not** the
official Open Banking API or Business API — those are separate, documented, and require
TPP registration or a business account respectively.

This documents the endpoints and data shapes as observed from browser DevTools.
All example data is fabricated.

## Authentication

Auth is extracted from a browser cURL command (DevTools → Network → Copy as cURL).
Three values are needed:

| Source | Header/Param | Description |
|--------|-------------|-------------|
| URL query param | `internalPocketId` | UUID identifying the currency pocket |
| Header | `cookie` | Full session cookie string |
| Header | `x-device-id` | Device identifier |

Additional headers sent (may not all be required):

```
x-browser-application: WEB_CLIENT
x-client-version: 100.0
```

Sessions expire. Error code `9039` indicates an expired token.

## Endpoints

### GET `/api/retail/user/current/transactions/last`

Fetches transactions for a single currency pocket, paginated backward in time.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `count` | number | Batch size (we use 500) |
| `internalPocketId` | string | UUID of the currency pocket |
| `to` | number | Epoch ms — fetch transactions before this timestamp |

**Response:** JSON array of transaction objects (see below). Returns `404` or empty
array at end of history.

**Pagination:** Use the oldest `startedDate` from the current batch minus 1ms as the
`to` parameter for the next request. Continue until empty/404 or consecutive empty batches.

## Transaction Object

All monetary amounts are in **minor units** (cents for fiat, satoshis for BTC, etc.).
Fiat currencies use 2 decimal places. See `CURRENCY_DECIMALS` in transform.ts for crypto.

### Core Fields

```jsonc
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",       // Transaction ID
  "legId": "a1b2c3d4-e5f6-7890-0000-ef1234567890",     // Leg ID (unique per side of a transfer)
  "groupKey": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",  // Groups related legs
  "type": "CARD_PAYMENT",     // See Transaction Types below
  "state": "COMPLETED",       // See States below
  "startedDate": 1772324354000,   // Epoch ms — when initiated
  "updatedDate": 1772455578005,   // Epoch ms — last update
  "completedDate": 1772455578002, // Epoch ms — when settled (absent if PENDING)
  "createdDate": 1772324354393,   // Epoch ms — when created in system
  "currency": "CZK",          // ISO currency code (or "X:8:SUI" for some crypto)
  "amount": -10000,           // Minor units, negative = outflow
  "fee": 0,                   // Fee in minor units
  "balance": 53600,           // Post-transaction running balance (minor units, absent if PENDING)
  "description": "Some Merchant",
  "tag": "restaurants",       // Revolut's category tag
  "category": "restaurants",  // Revolut's category (usually same as tag)
}
```

### Account Info

Present on all transactions. Identifies which pocket (current vs savings) the
transaction belongs to.

```jsonc
{
  "account": {
    "id": "11111111-2222-3333-4444-555555555555",
    "type": "CURRENT"   // "CURRENT" = main account, "SAVINGS" = vault/savings pocket
  }
}
```

**Important:** The `balance` field reflects the balance of whichever account type
the transaction belongs to. A SAVINGS transaction's balance is the vault balance,
not the current account balance.

### States

| State | Description |
|-------|-------------|
| `COMPLETED` | Settled transaction |
| `PENDING` | Authorized but not settled (no `balance` or `completedDate`) |
| `REVERTED` | Reversed/cancelled after completion |
| `DECLINED` | Rejected by Revolut or merchant |

### Transaction Types

| Type | Description | Amount sign |
|------|-------------|-------------|
| `CARD_PAYMENT` | Card purchase (POS or online) | negative |
| `CARD_REFUND` | Refund from merchant | positive |
| `TRANSFER` | P2P transfer or vault movement | either |
| `EXCHANGE` | Currency exchange (two legs) | negative=sell, positive=buy |
| `TOPUP` | Adding money from external card/bank | positive |
| `ATM` | Cash withdrawal | negative |
| `FEE` | Revolut fee (card delivery, etc.) | see note below |
| `CHARGE` | Subscription/plan fee | `amount: 0`, actual cost in `fee` field |
| `REV_PAYMENT` | Revolut Pay (online payment via Revolut) | negative |
| `REWARD` | Referral bonus, cashback | positive |

**FEE vs CHARGE:** `FEE` has the cost in `amount`. `CHARGE` has `amount: 0` with
the actual cost in `fee` and `amountWithCharges` (`amount - fee`).

### Merchant (card payments, ATM, refunds)

```jsonc
{
  "merchant": {
    "name": "Coffee Shop",
    "id": "12345678",
    "scheme": "VISA",           // or "MASTERCARD"
    "mcc": "5814",              // Merchant Category Code
    "category": "restaurants",
    "city": "Prague",
    "country": "CZ",
    "address": "10000, Prague, CZ"
  },
  "countryCode": "CZ",
  "card": {
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "lastFour": "1234",
    "disposable": false,
    "credit": false
  }
}
```

### Exchange Transactions

Currency exchanges produce **two legs** sharing the same `id` but different `legId`s:

- **Outgoing leg** (negative amount): the currency being sold
- **Receiving leg** (positive amount): the currency being bought

```jsonc
// Outgoing leg (selling EUR)
{
  "type": "EXCHANGE",
  "currency": "EUR",
  "amount": -5000,           // -50.00 EUR
  "rate": 25.5,              // exchange rate
  "direction": "sell",
  "counterpart": {
    "amount": 127500,        // +1275.00 CZK
    "currency": "CZK"
  }
}

// Receiving leg (buying CZK) — appears in CZK transaction list
{
  "type": "EXCHANGE",
  "currency": "CZK",
  "amount": 127500,          // +1275.00 CZK
  "rate": 0.03921,
  "direction": "buy",
  "counterpart": {
    "amount": -5000,         // -50.00 EUR
    "currency": "EUR"
  }
}
```

**For import:** Only the outgoing (sell) leg is imported. The receiving leg's amount
is captured via `counterpart` on the outgoing leg.

### Vault/Savings Transfers

Internal movements between current account and savings vaults. Identified by the
presence of the `vault` field. Always produce two legs:

- **CURRENT leg:** Money leaving/entering the main account
- **SAVINGS leg:** Money entering/leaving the vault

```jsonc
// CURRENT leg (money to vault)
{
  "type": "TRANSFER",
  "amount": -5000,              // -50.00 leaving current account
  "account": { "type": "CURRENT" },
  "vault": {
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  },
  "fromAccount": {
    "type": "PERSONAL",
    "pocketId": "..."
  },
  "toAccount": {
    "type": "VAULT",
    "pocketId": "...",
    "relatedEntity": { "id": "...", "type": "MONEYBOX" }
  },
  "counterpart": {
    "amount": 5000,
    "currency": "CZK",
    "account": { "type": "SAVINGS" }
  }
}

// SAVINGS leg (money into vault)
{
  "type": "TRANSFER",
  "amount": 5000,               // +50.00 into vault
  "account": { "type": "SAVINGS" },
  "vault": {
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  }
}
```

Some vault exchanges (e.g., "Flexible Cash Funds" → CZK) appear as `EXCHANGE` type
with `vault` field set and `account.type: "SAVINGS"` on the outgoing leg.

**For import:** Both legs are imported (they net to zero on the same account).
Balance calculations filter out `account.type == "SAVINGS"` to avoid using
vault balances in assertions.

### P2P Transfers

Person-to-person transfers (Revolut-to-Revolut). No `vault` field.

```jsonc
{
  "type": "TRANSFER",
  "amount": 30000,             // +300.00 received
  "description": "From Jane D",
  "vault": null,               // absent — distinguishes from vault transfers
  "sender": {                  // present on incoming transfers
    "firstName": "Jane",
    "lastName": "Doe",
    "code": "jane123"
  },
  "recipient": {               // present on outgoing transfers
    "account": { "type": "CURRENT" }
  }
}
```

### Auto-Invest / Spare Change

Some vault transfers are triggered automatically (round-up spare change).
Indicated by `autoInvest` field:

```jsonc
{
  "autoInvest": {
    "target": {
      "id": "...",
      "type": "SAVINGS_POCKET"
    },
    "strategy": "SPARE_CHANGE"
  }
}
```

## Pocket IDs

Each currency has a separate "pocket" with a UUID. The `internalPocketId` query
parameter selects which pocket to fetch. A single pocket returns transactions for
that currency only, but vault/exchange transactions involving other currencies
appear as well (as the other leg).

SAVINGS pockets have a different ID from CURRENT pockets for the same currency.

## File Organization

Fetched transactions are saved as `{CURRENCY}_{YEAR}.json`, e.g., `CZK_2024.json`.
Each file is a JSON array of transaction objects, sorted newest-first.
Deduplication is by `legId`.

## Known Quirks

- **PENDING transactions** have no `balance` or `completedDate`. They affect
  displayed account balance in the app but not the running balance in the data.
- **Crypto currencies** use non-standard codes like `X:8:SUI` with colons and
  digits. These are sanitized to alpha-only (e.g., `XSUI`) for beancount.
- **CHARGE type** uses `amount: 0` with the real cost in `fee`. The `amountWithCharges`
  field has the combined value.
- **Exchange receiving legs** sometimes appear with `account.type: "SAVINGS"` when
  the destination is a vault — these are EXCHANGE type but on the savings account.
