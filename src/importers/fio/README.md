# Fio banka

## Fetching transactions (API)

```bash
bun run src/importers/fio/fetch.ts
```

### Setup

Each Fio account needs its own token. Add to `.env`:

```bash
FIO_TOKEN_CZK=your-64-character-token
FIO_TOKEN_EUR=another-token
# Use any descriptive suffix: PERSONAL, BUSINESS, SAVINGS, etc.
```

To get a token:

1. Sign in at https://ib.fio.cz
2. Go to **Nastavení** → **API**
3. Generate a new token (requires SMS/push auth)

Token names determine output directories: `FIO_TOKEN_CZK` → `raw/fio-czk/`

### Options

- `--account czk` - Fetch only this account
- `--incremental` - Only fetch new transactions since last download
- `--from 2024-01-01` - Fetch from specific date
- `--reset-marker 2024-01-01` - Reset the server-side "last download" marker

Note: Fio rate-limits to 30s between requests. Data older than 90 days requires manual unlock at ib.fio.cz.

## Downloading statements (manual alternative)

1. Sign in at https://ib.fio.cz
2. Go to **Přehledy** → **Výpisy z účtu**
3. Select the period
4. Download as **OFX**
5. Save to `raw/fio/`

## Files

- `*.json` - JSON transaction exports from API
- `*.ofx` - OFX transaction exports (manual download)
- `*.overrides.ts` - Per-file transaction overrides (optional)

## API docs

- Token API: https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf
- PSD2 API: https://developers.fio.cz/v3/api-docs-production.json
