/**
 * Amundi Czech Republic API client.
 *
 * Uses Keycloak for authentication (accounts.amundi.com) and the
 * suite.amundi.com API for investment data.
 *
 * Auth flow:
 *   1. POST to Keycloak token endpoint with username/password → access_token
 *   2. Use Bearer token for all API calls
 *   3. Token expires in 300s; refresh_token lasts 540s
 *
 * Data flow:
 *   1. Fetch orders (paginated) → collect order IDs
 *   2. Fetch trades by order ID batch → actual purchase/sale details
 *   3. Optionally fetch fund list for enriched metadata
 */

// ─── API response types ───────────────────────────────────────────────

export interface AmundiMoney {
	value: number;
	currency: string;
}

export interface AmundiFund {
	fundId: string;
	name: string;
	marketingName: string;
	isin: string;
	code: string;
	lei: string;
	typeCode: string;
	typeName: string;
	currency: string;
	specificCode: string;
	maximumEntryFee: number;
	maximumExitFee: number;
	ongoingFee: number;
}

export interface AmundiFundListResponse {
	fundList: AmundiFund[];
	rowCount: number;
	pageNumber: number;
}

export interface AmundiOrder {
	clientId: string;
	contractId: string;
	contractNumber: string;
	orderId: string;
	orderTypeCategoryCode: string;
	orderTypeCategoryName: string;
	orderTypeCode: string;
	orderTypeName: string;
	programCode: string;
	programName: string;
	orderDate: string;
	tradeDate: string;
	settlementDate: string;
	orderAmount: AmundiMoney;
	orderSellAll: boolean;
	tradedAmount: AmundiMoney;
	commissions: AmundiMoney;
	statusCode: string;
	statusName: string;
	fxOrderToSecurity: number;
	paymentMatchingDate?: string;
	periodicalOrderId?: string;
}

export interface AmundiOrdersResponse {
	orderList: AmundiOrder[];
	rowCount: number;
	pageNumber: number;
}

export interface AmundiTrade {
	clientId: string;
	contractNumber: string;
	contractId: string;
	orderId: string;
	orderTypeCategoryCode: string;
	orderTypeCategoryName: string;
	orderTypeCode: string;
	orderTypeName: string;
	directionCode: string;
	directionName: string;
	fundIsin: string;
	fundName: string;
	tradedAmount: AmundiMoney;
	tradedQuantity: number;
	tradedQuantityRounding: AmundiMoney;
	tradeDate: string;
	settlementDate: string;
	nav: number;
	navDate: string;
	tradeId: string;
}

export interface AmundiTradesResponse {
	tradeList: AmundiTrade[];
	rowCount: number;
	pageNumber: number;
}

export interface AmundiCashflow {
	clientId: string;
	contractId: string;
	contractNumber: string;
	paymentId: string;
	paymentTypeCode: string;
	paymentTypeName: string;
	directionCode: string;
	directionName: string;
	cashflowAmount: AmundiMoney;
	entryDate: string;
	settlementDate: string;
	bankAccount: string;
	counterpartyBankAccount: string;
	variableCode: string;
	specificCode: string;
	isEmployerContribution: boolean;
}

export interface AmundiCashflowResponse {
	cashflowList: AmundiCashflow[];
	rowCount: number;
	pageNumber: number;
}

// ─── Keycloak auth ────────────────────────────────────────────────────

export interface KeycloakTokenResponse {
	access_token: string;
	expires_in: number;
	refresh_expires_in: number;
	refresh_token: string;
	token_type: string;
	id_token: string;
	session_state: string;
	scope: string;
}

export const KEYCLOAK_TOKEN_URL =
	"https://accounts.amundi.com/auth/realms/MojeAmundi/protocol/openid-connect/token";

export const API_BASE = "https://suite.amundi.com/cs/moje/api/external";

export interface AmundiClientDetail {
	clientId: string;
	personType: string;
}

export interface AmundiClientResponse {
	clientDetail: AmundiClientDetail[];
}

export interface AmundiContract {
	clientId: string;
	contractId: string;
	contractNumber: string;
	contractTypeCode: string;
	contractTypeName: string;
	contractTypeMarketingName: string;
	programCode: string;
	programName: string;
	statusCode: string;
	statusName: string;
	activationDate: string;
	currency: string;
	name: string;
}

export interface AmundiContractListResponse {
	contractList: AmundiContract[];
	rowCount: number;
	pageNumber: number;
}

// ─── Request body types ───────────────────────────────────────────────

interface OperationContext {
	correlationId: string;
	systemId: string;
	userApplication: string;
	languageCode: string;
}

function makeOperationContext(): OperationContext {
	return {
		correlationId: crypto.randomUUID(),
		systemId: "Lundegaard",
		userApplication: "FE_MOJE",
		languageCode: "cs",
	};
}

interface OrdersRequestBody {
	contractNumber: string;
	orderDateFrom: string;
	orderDateTo: string;
	status: string[];
	sortBy: { columnName: string; direction: string }[];
	pageNumber: number;
	rowCountPerPage: number;
	operationContext: OperationContext;
}

interface TradesRequestBody {
	clientId: string;
	orderId: string[];
	operationContext: OperationContext;
}

interface CashflowRequestBody {
	contractNumber: string;
	entryDateFrom: string;
	entryDateTo: string;
	sortBy: { columnName: string; direction: string }[];
	pageNumber: number;
	rowCountPerPage: number;
	operationContext: OperationContext;
}

// ─── API client ───────────────────────────────────────────────────────

/**
 * Authenticate via Keycloak password grant.
 */
export async function authenticate(
	username: string,
	password: string,
	clientId: string,
): Promise<KeycloakTokenResponse> {
	const body = new URLSearchParams({
		grant_type: "password",
		client_id: clientId,
		username,
		password,
	});

	const response = await fetch(KEYCLOAK_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Keycloak auth failed (${response.status}): ${text}`);
	}

	return response.json() as Promise<KeycloakTokenResponse>;
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshToken(
	refreshTokenValue: string,
	clientId: string,
): Promise<KeycloakTokenResponse> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshTokenValue,
	});

	const response = await fetch(KEYCLOAK_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed (${response.status}): ${text}`);
	}

	return response.json() as Promise<KeycloakTokenResponse>;
}

async function parseJsonResponse<T>(
	response: Response,
	endpoint: string,
): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`API ${endpoint} failed (${response.status}): ${text.slice(0, 500)}`,
		);
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			`API ${endpoint} returned non-JSON (${response.status}, ${response.headers.get("content-type")}): ${text.slice(0, 500)}`,
		);
	}
}

async function apiPost<T>(
	token: string,
	endpoint: string,
	body: unknown,
): Promise<T> {
	const url = `${API_BASE}/${endpoint}`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	return parseJsonResponse<T>(response, endpoint);
}

/**
 * Extract clientId from a JWT access token.
 * The token payload contains user claims including the moje identifier.
 */
export function extractMojeIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(
			Buffer.from(payload, "base64url").toString(),
		) as Record<string, unknown>;
		// mojeIdentifier is the person ID, used for contract list lookups
		const id = decoded.mojeIdentifier ?? decoded.moje_identifier;
		if (typeof id === "number") return String(id);
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fetch client details from a naturalPersonId (mojeIdentifier from JWT).
 * Returns clientId needed for other API calls.
 */
export async function fetchClient(
	token: string,
	naturalPersonId: string,
): Promise<AmundiClientResponse> {
	return apiPost<AmundiClientResponse>(token, "contract/client/get", {
		naturalPersonId,
		operationContext: makeOperationContext(),
	});
}

/**
 * Fetch contract list for a client.
 */
export async function fetchContracts(
	token: string,
	clientId: string,
): Promise<AmundiContractListResponse> {
	return apiPost<AmundiContractListResponse>(
		token,
		"contract/list?version=2.4",
		{ clientId, operationContext: makeOperationContext() },
	);
}

/**
 * Fetch fund details for specific ISINs.
 */
export async function fetchFundList(
	token: string,
	isins: string[],
	clientId: string,
): Promise<AmundiFundListResponse> {
	return apiPost<AmundiFundListResponse>(
		token,
		"product/fund/list?version=2.4",
		{
			isin: isins,
			operationContext: {
				...makeOperationContext(),
				clientIdContext: clientId,
			},
		},
	);
}

/**
 * Fetch a page of orders for a contract.
 */
export async function fetchOrders(
	token: string,
	contractNumber: string,
	pageNumber = 1,
	rowCountPerPage = 30,
): Promise<AmundiOrdersResponse> {
	const body: OrdersRequestBody = {
		contractNumber,
		orderDateFrom: "1970-01-01",
		orderDateTo: "9999-01-01",
		status: ["RECEIVED", "VALIDATED", "FINISHED", "REVERSING", "REVERSED"],
		sortBy: [{ columnName: "orderDate", direction: "DESC" }],
		pageNumber,
		rowCountPerPage,
		operationContext: makeOperationContext(),
	};

	return apiPost<AmundiOrdersResponse>(
		token,
		"contract/orders/get?version=2.3",
		body,
	);
}

/**
 * Fetch all orders for a contract (handles pagination).
 */
export async function fetchAllOrders(
	token: string,
	contractNumber: string,
): Promise<AmundiOrder[]> {
	const allOrders: AmundiOrder[] = [];
	let page = 1;
	const perPage = 30;

	while (true) {
		const response = await fetchOrders(token, contractNumber, page, perPage);
		allOrders.push(...response.orderList);

		if (allOrders.length >= response.rowCount) break;
		page++;
	}

	return allOrders;
}

/**
 * Fetch trades for a batch of order IDs.
 */
export async function fetchTrades(
	token: string,
	clientId: string,
	orderIds: string[],
): Promise<AmundiTradesResponse> {
	const body: TradesRequestBody = {
		clientId,
		orderId: orderIds,
		operationContext: makeOperationContext(),
	};

	return apiPost<AmundiTradesResponse>(
		token,
		"contract/trades/get?version=2.3",
		body,
	);
}

/**
 * Fetch all trades for all orders, batching order IDs.
 */
export async function fetchAllTrades(
	token: string,
	clientId: string,
	orderIds: string[],
	batchSize = 30,
): Promise<AmundiTrade[]> {
	const allTrades: AmundiTrade[] = [];

	for (let i = 0; i < orderIds.length; i += batchSize) {
		const batch = orderIds.slice(i, i + batchSize);
		const response = await fetchTrades(token, clientId, batch);
		allTrades.push(...response.tradeList);
	}

	return allTrades;
}

/**
 * Fetch a page of cashflows for a contract.
 */
export async function fetchCashflow(
	token: string,
	contractNumber: string,
	pageNumber = 1,
	rowCountPerPage = 30,
): Promise<AmundiCashflowResponse> {
	const body: CashflowRequestBody = {
		contractNumber,
		entryDateFrom: "1970-01-01",
		entryDateTo: "9999-01-01",
		sortBy: [{ columnName: "entryDate", direction: "DESC" }],
		pageNumber,
		rowCountPerPage,
		operationContext: makeOperationContext(),
	};

	return apiPost<AmundiCashflowResponse>(
		token,
		"contract/cashflow/get?version=2.3",
		body,
	);
}

/**
 * Fetch all cashflows for a contract (handles pagination).
 */
export async function fetchAllCashflow(
	token: string,
	contractNumber: string,
): Promise<AmundiCashflow[]> {
	const allCashflows: AmundiCashflow[] = [];
	let page = 1;
	const perPage = 30;

	while (true) {
		const response = await fetchCashflow(token, contractNumber, page, perPage);
		allCashflows.push(...response.cashflowList);

		if (allCashflows.length >= response.rowCount) break;
		page++;
	}

	return allCashflows;
}
