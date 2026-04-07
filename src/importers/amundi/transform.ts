/**
 * Amundi investment fund importer.
 *
 * Reads JSON files saved by the fetch script:
 *   - trades.json — executed trades with unit counts, NAV, amounts
 *   - orders.json — optional orders for entry fee + rounding calculation
 *   - funds.json — optional fund metadata for enriched commodity definitions
 *
 * Produces Transaction objects with commodity postings for fund purchases/sales,
 * plus price directives and commodity definitions.
 *
 * The bank-side transactions (deposits into the cash account) are handled by the
 * main pipeline via categorization rules. This importer generates the Amundi-internal
 * movements: share purchases, entry fees, and rounding adjustments.
 *
 * When orders.json is present, entry fees are derived per trade as:
 *   fee = orderAmount - tradedAmount - tradedQuantityRounding
 * Rounding residuals are also tracked explicitly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CommodityDefinition,
	ImportError,
	ImportResult,
	Price,
	Transaction,
} from "../../types.ts";
import type { AmundiFund, AmundiOrder, AmundiTrade } from "./api.ts";

export interface AmundiConfig {
	/** Account for fund units (default: Assets:Investments:Amundi) */
	fundAccount?: string;
	/** Account for cash held at Amundi (default: Assets:Investments:Amundi:Cash) */
	cashAccount?: string;
	/** Account for entry fees (default: Expenses:Finance:Investments:Fees) */
	feeAccount?: string;
	/** Override commodity symbols by ISIN (default: derived from fund name) */
	commoditySymbols?: Record<string, string>;
}

/**
 * Derive a beancount commodity symbol from a fund name.
 * Strips common prefixes/suffixes and abbreviates.
 *
 * "Amundi CR All-Star Selection - class A" → "ALLSTARS"
 * "Amundi CR Český akciový fond - class A" → "CESKYAKC"
 */
export function deriveCommoditySymbol(fundName: string): string {
	const cleaned = fundName
		.replace(/^Amundi\s+CR\s+/i, "")
		.replace(/\s*-\s*class\s+\w+$/i, "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // strip diacritics
		.replace(/[^a-zA-Z0-9\s]/g, "")
		.trim();

	const words = cleaned.split(/\s+/);
	let symbol = "";
	for (const word of words) {
		if (symbol.length >= 8) break;
		const remaining = 8 - symbol.length;
		const take = Math.min(word.length, Math.max(3, remaining));
		symbol += word.slice(0, take).toUpperCase();
	}

	return symbol.slice(0, 10) || "AMUNDI";
}

function readJsonFile<T>(filePath: string): T {
	const content = readFileSync(filePath, "utf-8");
	return JSON.parse(content) as T;
}

/**
 * Import Amundi investment data from a directory containing JSON exports.
 *
 * Required: trades.json (AmundiTrade[])
 * Optional: orders.json (AmundiOrder[]) — for entry fee calculation
 * Optional: funds.json (AmundiFund[]) — enriches commodity metadata
 */
export function importAmundiDirectory(
	dirPath: string,
	config: AmundiConfig = {},
): ImportResult {
	const errors: ImportError[] = [];
	const transactions: Transaction[] = [];
	const prices: Price[] = [];

	const tradesFile = join(dirPath, "trades.json");
	if (!existsSync(tradesFile)) {
		errors.push({ source: dirPath, message: "No trades.json file found" });
		return { transactions, errors };
	}

	const trades = readJsonFile<AmundiTrade[]>(tradesFile);
	if (trades.length === 0) {
		return { transactions, errors };
	}

	// Optional fund metadata
	const fundsFile = join(dirPath, "funds.json");
	const fundsByIsin = new Map<string, AmundiFund>();
	if (existsSync(fundsFile)) {
		const funds = readJsonFile<AmundiFund[]>(fundsFile);
		for (const fund of funds) {
			fundsByIsin.set(fund.isin, fund);
		}
	}

	// Optional order data (for entry fee calculation)
	const ordersFile = join(dirPath, "orders.json");
	const ordersByOrderId = new Map<string, AmundiOrder>();
	if (existsSync(ordersFile)) {
		const orders = readJsonFile<AmundiOrder[]>(ordersFile);
		for (const order of orders) {
			ordersByOrderId.set(order.orderId, order);
		}
	}

	// Resolve account paths
	const fundAccount = config.fundAccount ?? "Assets:Investments:Amundi";
	const cashAccount = config.cashAccount ?? "Assets:Investments:Amundi:Cash";
	const feeAccount = config.feeAccount ?? "Expenses:Finance:Investments:Fees";

	// Build commodity symbol lookup: ISIN → symbol
	const isinToSymbol = new Map<string, string>();
	function getSymbol(isin: string, fundName: string): string {
		let symbol = isinToSymbol.get(isin);
		if (symbol) return symbol;
		symbol = config.commoditySymbols?.[isin] ?? deriveCommoditySymbol(fundName);
		isinToSymbol.set(isin, symbol);
		return symbol;
	}

	// Sort trades by date ascending (API returns newest first)
	const sortedTrades = [...trades].sort((a, b) =>
		a.tradeDate.localeCompare(b.tradeDate),
	);

	// Generate commodity transactions from trades
	for (const trade of sortedTrades) {
		const symbol = getSymbol(trade.fundIsin, trade.fundName);
		const isBuy = trade.directionCode === "BUY";
		const units = isBuy ? trade.tradedQuantity : -trade.tradedQuantity;
		const cashAmount = isBuy
			? -trade.tradedAmount.value
			: trade.tradedAmount.value;

		transactions.push({
			id: `amundi-${trade.tradeId}`,
			date: trade.tradeDate,
			amount: { value: cashAmount, currency: trade.tradedAmount.currency },
			description: `${isBuy ? "Nákup" : "Prodej"} ${trade.fundName}`,
			payee: "Amundi",
			account: cashAccount,
			source: tradesFile,
			commodity: {
				account: fundAccount,
				symbol,
				units,
				costPerUnit: {
					value: trade.nav,
					currency: trade.tradedAmount.currency,
				},
			},
		});

		// Entry fee: order amount - (traded amount + rounding) = fee
		const order = ordersByOrderId.get(trade.orderId);
		if (order) {
			const fee =
				order.orderAmount.value -
				trade.tradedAmount.value -
				trade.tradedQuantityRounding.value;
			if (fee > 0.01) {
				transactions.push({
					id: `amundi-fee-${trade.tradeId}`,
					date: trade.tradeDate,
					amount: { value: -fee, currency: trade.tradedAmount.currency },
					description: "Vstupn\u00ed poplatek",
					payee: "Amundi",
					category: feeAccount,
					account: cashAccount,
					source: ordersFile,
				});
			}

			// Rounding stays as cash (small residual per trade)
			if (trade.tradedQuantityRounding.value > 0) {
				const roundingAccount = "Income:Investments:Amundi:Rounding";
				transactions.push({
					id: `amundi-round-${trade.tradeId}`,
					date: trade.tradeDate,
					amount: {
						value: -trade.tradedQuantityRounding.value,
						currency: trade.tradedAmount.currency,
					},
					description: "Zaokrouhlen\u00ed",
					payee: "Amundi",
					category: roundingAccount,
					account: cashAccount,
					source: tradesFile,
				});
			}
		}

		// Price directive from NAV
		prices.push({
			date: trade.navDate,
			baseCurrency: symbol,
			quoteCurrency: trade.tradedAmount.currency,
			price: trade.nav,
			source: tradesFile,
		});
	}

	// Collect unique funds for commodity definitions
	const commodities: CommodityDefinition[] = [];
	const seenIsins = new Set<string>();

	for (const trade of sortedTrades) {
		if (seenIsins.has(trade.fundIsin)) continue;
		seenIsins.add(trade.fundIsin);

		const symbol = getSymbol(trade.fundIsin, trade.fundName);
		const fundMeta = fundsByIsin.get(trade.fundIsin);

		commodities.push({
			symbol,
			name: fundMeta?.name ?? trade.fundName,
			isin: trade.fundIsin,
			date: trade.tradeDate,
		});
	}

	return {
		transactions,
		errors,
		prices,
		commodities,
	};
}
