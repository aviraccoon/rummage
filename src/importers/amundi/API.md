# Amundi Czech Republic API

Internal API used by the Amundi "Moje Amundi" portal at `moje.amundi.com/cz`
(API requests go to `suite.amundi.com`).
Built by Lundegaard. Not publicly documented.

All example data is fabricated.

## Authentication

Keycloak at `accounts.amundi.com`, realm `MojeAmundi`.

### Password Grant (Direct Access)

```
POST /auth/realms/MojeAmundi/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&client_id=prd-nma-215640&username=user@example.com&password=hunter2
```

**Response:**

```json
{
  "access_token": "eyJhbG...",
  "expires_in": 300,
  "refresh_expires_in": 540,
  "refresh_token": "eyJhbG...",
  "token_type": "Bearer",
  "id_token": "eyJhbG...",
  "scope": "openid mojeIdentifier profile email"
}
```

- Access token expires in **5 minutes**
- Refresh token expires in **9 minutes**
- Tokens are JWTs with `mojeIdentifier` claim (= naturalPersonId, not clientId)

### JWT Claims

```json
{
  "mojeIdentifier": "1234567",
  "roles": ["ROLE_MOJE_EXTERNAL_API", "ROLE_MOJE_USER", "ROLE_SWAGGER"],
  "azp": "prd-nma-215640",
  "scope": "openid mojeIdentifier profile email"
}
```

`mojeIdentifier` is the **naturalPersonId** — needed for the client lookup
endpoint, but NOT the same as `clientId` used by most other endpoints.

### Authorization

All API requests use:
```
Authorization: Bearer <access_token>
```

## Base URL

```
https://suite.amundi.com/cs/moje/api/external
```

## Common Request Pattern

All POST endpoints include an `operationContext` object:

```json
{
  "operationContext": {
    "correlationId": "uuid-v4",
    "systemId": "Lundegaard",
    "userApplication": "FE_MOJE",
    "languageCode": "cs"
  }
}
```

Some endpoints add `clientIdContext` to the operation context (e.g., fund list).

## ID Resolution Chain

To go from an authenticated token to usable data:

```
JWT mojeIdentifier → contract/client/get → clientId
clientId → contract/list → contractNumber
contractNumber + clientId → orders/trades/cashflow
```

## Endpoints

### POST `contract/client/get`

Maps naturalPersonId (from JWT) to clientId.

**Request:**
```json
{
  "naturalPersonId": "1234567",
  "operationContext": { "..." }
}
```

**Response:**
```json
{
  "clientDetail": [{
    "clientId": "9876543",
    "personType": "NATURAL"
  }]
}
```

### POST `contract/list?version=2.4`

Lists investment contracts for a client.

**Request:**
```json
{
  "clientId": "9876543",
  "operationContext": { "..." }
}
```

**Response:**
```json
{
  "contractList": [{
    "clientId": "9876543",
    "contractId": "1111111",
    "contractNumber": "2380000000",
    "contractTypeCode": "AMUNDIR3S",
    "contractTypeMarketingName": "Amundi RENTIER 3S",
    "programCode": "AMR3SL10",
    "programName": "3S - Linie 10",
    "statusCode": "ACTIVE",
    "activationDate": "2021-02-14",
    "currency": "CZK",
    "name": "My Investment"
  }],
  "rowCount": 1,
  "pageNumber": 1
}
```

### POST `contract/orders/get?version=2.3`

Lists buy/sell orders for a contract. Paginated.

**Request:**
```json
{
  "contractNumber": "2380000000",
  "orderDateFrom": "1970-01-01",
  "orderDateTo": "9999-01-01",
  "status": ["RECEIVED", "VALIDATED", "FINISHED", "REVERSING", "REVERSED"],
  "sortBy": [{"columnName": "orderDate", "direction": "DESC"}],
  "pageNumber": 1,
  "rowCountPerPage": 30,
  "operationContext": { "..." }
}
```

**Response:**
```json
{
  "orderList": [{
    "clientId": "9876543",
    "contractNumber": "2380000000",
    "orderId": "200000001",
    "orderTypeCategoryCode": "BUY",
    "programCode": "AMR3SL10",
    "programName": "3S - Linie 10",
    "orderDate": "2025-06-18",
    "tradeDate": "2025-06-23",
    "settlementDate": "2025-06-23",
    "orderAmount": {"value": 6500, "currency": "CZK"},
    "tradedAmount": {"value": 6500, "currency": "CZK"},
    "commissions": {"value": 0, "currency": "CZK"},
    "statusCode": "FINISHED",
    "fxOrderToSecurity": 1
  }],
  "rowCount": 56,
  "pageNumber": 1
}
```

**Notes:**
- `orderAmount` is what was deposited; `tradedAmount` is what was used
  (may differ due to entry fees taken from the deposit)
- `commissions` is typically 0 even when fees exist — fees are implicit
  in the difference between orderAmount and the trade's tradedAmount + rounding
- Pagination: increment `pageNumber` until `orderList` length accumulates to `rowCount`

### POST `contract/trades/get?version=2.3`

Fetches executed trades for a batch of order IDs. **Not paginated** — takes
an array of order IDs directly.

**Request:**
```json
{
  "clientId": "9876543",
  "orderId": ["200000001", "200000002"],
  "operationContext": { "..." }
}
```

**Response:**
```json
{
  "tradeList": [{
    "orderId": "200000001",
    "directionCode": "BUY",
    "fundIsin": "CZ0008470001",
    "fundName": "Amundi CR Test Fund - class A",
    "tradedAmount": {"value": 2599.65, "currency": "CZK"},
    "tradedQuantity": 1872,
    "tradedQuantityRounding": {"value": 0.35, "currency": "CZK"},
    "tradeDate": "2025-06-23",
    "settlementDate": "2025-06-23",
    "nav": 1.3887,
    "navDate": "2025-06-19",
    "tradeId": "300000001"
  }],
  "rowCount": 2,
  "pageNumber": 1
}
```

**Notes:**
- `tradedQuantity` is always an integer (whole units only)
- `tradedQuantityRounding` is the CZK leftover from rounding to whole units
- `tradedAmount + tradedQuantityRounding` = total CZK used from the deposit
  after entry fees are deducted
- `nav` is the Net Asset Value (price per unit) on `navDate`
- One order typically produces one trade, but could produce multiple
  for orders spanning multiple funds
- Batch size: observed up to 26 IDs per request; we use 30

### POST `product/fund/list?version=2.4`

Fund metadata. Takes specific ISINs — not a general catalog endpoint.

**Request:**
```json
{
  "isin": ["CZ0008470001"],
  "operationContext": {
    "correlationId": "...",
    "systemId": "Lundegaard",
    "userApplication": "FE_MOJE",
    "languageCode": "cs",
    "clientIdContext": "9876543"
  }
}
```

**Response:**
```json
{
  "fundList": [{
    "fundId": "1000001",
    "name": "Amundi CR Test Fund - class A",
    "isin": "CZ0008470001",
    "code": "015",
    "typeCode": "EQUITY",
    "typeName": "Akciový",
    "currency": "CZK",
    "maximumEntryFee": 0.05,
    "maximumExitFee": 0,
    "ongoingFee": 0.02451,
    "aum": 5138961540.15,
    "sri": 3,
    "srri": 4,
    "sfdrSustainability": "8"
  }],
  "rowCount": 1,
  "pageNumber": 1
}
```

**Notes:**
- `operationContext` includes `clientIdContext` (unlike other endpoints)
- `maximumEntryFee` of 0.05 = up to 5%; actual fee depends on the program
  and intermediary agreement
- `aum` = Assets Under Management in fund currency

### POST `contract/cashflow/get?version=2.3`

Cash movements (deposits/withdrawals). Paginated.

**Request:**
```json
{
  "contractNumber": "2380000000",
  "entryDateFrom": "1970-01-01",
  "entryDateTo": "9999-01-01",
  "sortBy": [{"columnName": "entryDate", "direction": "DESC"}],
  "pageNumber": 1,
  "rowCountPerPage": 30,
  "operationContext": { "..." }
}
```

**Response:**
```json
{
  "cashflowList": [{
    "paymentId": "250000001",
    "paymentTypeCode": "BUY<-CLI",
    "paymentTypeName": "Investice",
    "directionCode": "IN",
    "cashflowAmount": {"value": 6500, "currency": "CZK"},
    "entryDate": "2025-06-18",
    "settlementDate": "2025-06-18",
    "bankAccount": "2100000000/2700",
    "counterpartyBankAccount": "1234567890/0100",
    "variableCode": "2380000000",
    "isEmployerContribution": false
  }],
  "rowCount": 56,
  "pageNumber": 1
}
```

## Fee Structure (3S Program)

The Amundi RENTIER 3S program (sold through intermediaries like OVB) front-loads
entry fees across the first ~21 months rather than charging per-transaction:

- Deposits are a fixed monthly amount (e.g., 6,500 CZK)
- Early deposits: ~60% goes to entry fee, ~40% to unit purchases
- Later deposits: 100% goes to unit purchases (0 fee)
- The fee is **not visible** in the `commissions` field on orders (always 0)
- It's only detectable by comparing `orderAmount` to `tradedAmount + tradedQuantityRounding`

Fee per order = `orderAmount - tradedAmount - tradedQuantityRounding`
