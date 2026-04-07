import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AmundiOrder, AmundiTrade } from "./api.ts";
import { deriveCommoditySymbol, importAmundiDirectory } from "./transform.ts";

function makeTrade(overrides: Partial<AmundiTrade> = {}): AmundiTrade {
	return {
		clientId: "1234567",
		contractNumber: "9990001234",
		contractId: "7654321",
		orderId: "100000001",
		orderTypeCategoryCode: "BUY",
		orderTypeCategoryName: "Investice",
		orderTypeCode: "PRGBUY-RELD",
		orderTypeName: "Investice vztažená D",
		directionCode: "BUY",
		directionName: "Primární prodej",
		fundIsin: "CZ0008470001",
		fundName: "Amundi CR Test Fund - class A",
		tradedAmount: { value: 4999.5, currency: "CZK" },
		tradedQuantity: 2500,
		tradedQuantityRounding: { value: 0.5, currency: "CZK" },
		tradeDate: "2025-06-23",
		settlementDate: "2025-06-23",
		nav: 1.9998,
		navDate: "2025-06-19",
		tradeId: "500000001",
		...overrides,
	};
}

function makeOrder(overrides: Partial<AmundiOrder> = {}): AmundiOrder {
	return {
		clientId: "1234567",
		contractId: "7654321",
		contractNumber: "9990001234",
		orderId: "100000001",
		orderTypeCategoryCode: "BUY",
		orderTypeCategoryName: "Investice",
		orderTypeCode: "AMR3SPRGBUYSTD-COM",
		orderTypeName: "Investice AMUNDI R3S STANDARD",
		programCode: "AMR3SL10",
		programName: "3S - Linie 10",
		orderDate: "2025-06-18",
		tradeDate: "2025-06-23",
		settlementDate: "2025-06-23",
		orderAmount: { value: 5000, currency: "CZK" },
		orderSellAll: false,
		tradedAmount: { value: 5000, currency: "CZK" },
		commissions: { value: 0, currency: "CZK" },
		statusCode: "FINISHED",
		statusName: "Dokon\u010den\u00e1",
		fxOrderToSecurity: 1,
		...overrides,
	};
}

function setupDir(trades: AmundiTrade[], orders?: AmundiOrder[]): string {
	const dir = mkdtempSync(join(tmpdir(), "amundi-test-"));
	writeFileSync(join(dir, "trades.json"), JSON.stringify(trades));
	if (orders) {
		writeFileSync(join(dir, "orders.json"), JSON.stringify(orders));
	}
	return dir;
}

describe("deriveCommoditySymbol", () => {
	test("derives from Amundi fund name", () => {
		expect(
			deriveCommoditySymbol("Amundi CR All-Star Selection - class A"),
		).toBe("ALLSTARSEL");
	});

	test("handles name without Amundi CR prefix", () => {
		expect(deriveCommoditySymbol("Český akciový fond")).toBe("CESKYAKC");
	});

	test("handles short names", () => {
		expect(deriveCommoditySymbol("Amundi CR Bond - class A")).toBe("BOND");
	});

	test("returns fallback for empty", () => {
		expect(deriveCommoditySymbol("Amundi CR  - class A")).toBe("AMUNDI");
	});
});

describe("importAmundiDirectory", () => {
	test("returns error when trades.json missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "amundi-empty-"));
		const result = importAmundiDirectory(dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain("No trades.json");
	});

	test("handles empty trades array", () => {
		const dir = setupDir([]);
		const result = importAmundiDirectory(dir);
		expect(result.transactions).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});

	test("generates commodity transaction from BUY trade", () => {
		const dir = setupDir([makeTrade()]);
		const result = importAmundiDirectory(dir);

		expect(result.transactions).toHaveLength(1);
		const txn = result.transactions[0];

		expect(txn?.id).toBe("amundi-500000001");
		expect(txn?.date).toBe("2025-06-23");
		expect(txn?.amount).toEqual({ value: -4999.5, currency: "CZK" });
		expect(txn?.payee).toBe("Amundi");
		expect(txn?.account).toBe("Assets:Investments:Amundi:Cash");
		expect(txn?.description).toBe("Nákup Amundi CR Test Fund - class A");
		expect(txn?.commodity).toEqual({
			account: "Assets:Investments:Amundi",
			symbol: "TESTFUND",
			units: 2500,
			costPerUnit: { value: 1.9998, currency: "CZK" },
		});
	});

	test("generates SELL transaction with negative units", () => {
		const dir = setupDir([
			makeTrade({
				directionCode: "SELL",
				tradeId: "500000002",
			}),
		]);
		const result = importAmundiDirectory(dir);
		const txn = result.transactions[0];

		expect(txn?.amount.value).toBe(4999.5); // cash inflow
		expect(txn?.commodity?.units).toBe(-2500); // units sold
		expect(txn?.description).toStartWith("Prodej");
	});

	test("generates price directives from NAV", () => {
		const dir = setupDir([makeTrade()]);
		const result = importAmundiDirectory(dir);

		expect(result.prices).toHaveLength(1);
		const price = result.prices?.[0];
		expect(price?.date).toBe("2025-06-19"); // navDate, not tradeDate
		expect(price?.baseCurrency).toBe("TESTFUND");
		expect(price?.quoteCurrency).toBe("CZK");
		expect(price?.price).toBe(1.9998);
	});

	test("generates commodity definitions", () => {
		const dir = setupDir([makeTrade()]);
		const result = importAmundiDirectory(dir);

		expect(result.commodities).toHaveLength(1);
		const commodity = result.commodities?.[0];
		expect(commodity?.symbol).toBe("TESTFUND");
		expect(commodity?.isin).toBe("CZ0008470001");
		expect(commodity?.name).toBe("Amundi CR Test Fund - class A");
	});

	test("deduplicates commodity definitions for same ISIN", () => {
		const dir = setupDir([
			makeTrade({ tradeId: "1", tradeDate: "2025-06-23" }),
			makeTrade({ tradeId: "2", tradeDate: "2025-07-23" }),
		]);
		const result = importAmundiDirectory(dir);

		expect(result.transactions).toHaveLength(2);
		expect(result.commodities).toHaveLength(1);
	});

	test("handles multiple funds", () => {
		const dir = setupDir([
			makeTrade({ tradeId: "1" }),
			makeTrade({
				tradeId: "2",
				fundIsin: "CZ0008470002",
				fundName: "Amundi CR Bond Fund - class A",
			}),
		]);
		const result = importAmundiDirectory(dir);

		expect(result.commodities).toHaveLength(2);
		const symbols = result.commodities?.map((c) => c.symbol);
		expect(symbols).toContain("TESTFUND");
		expect(symbols).toContain("BONDFUND");
	});

	test("sorts trades by date ascending", () => {
		const dir = setupDir([
			makeTrade({ tradeId: "2", tradeDate: "2025-07-23" }),
			makeTrade({ tradeId: "1", tradeDate: "2025-06-23" }),
		]);
		const result = importAmundiDirectory(dir);

		expect(result.transactions[0]?.date).toBe("2025-06-23");
		expect(result.transactions[1]?.date).toBe("2025-07-23");
	});

	test("uses custom config", () => {
		const dir = setupDir([makeTrade()]);
		const result = importAmundiDirectory(dir, {
			fundAccount: "Assets:Funds:Amundi",
			cashAccount: "Assets:Funds:Amundi:CZK",
			commoditySymbols: { CZ0008470001: "AMTEST" },
		});

		const txn = result.transactions[0];
		expect(txn?.account).toBe("Assets:Funds:Amundi:CZK");
		expect(txn?.commodity?.account).toBe("Assets:Funds:Amundi");
		expect(txn?.commodity?.symbol).toBe("AMTEST");
	});

	test("uses fund metadata from funds.json when available", () => {
		const dir = setupDir([makeTrade()]);
		writeFileSync(
			join(dir, "funds.json"),
			JSON.stringify([
				{
					fundId: "1000001",
					name: "Amundi CR Test Fund - class A (enriched)",
					isin: "CZ0008470001",
					code: "015",
					currency: "CZK",
				},
			]),
		);

		const result = importAmundiDirectory(dir);
		expect(result.commodities?.[0]?.name).toBe(
			"Amundi CR Test Fund - class A (enriched)",
		);
	});

	test("generates fee transaction when order amount exceeds trade amount", () => {
		const trade = makeTrade();
		const order = makeOrder({
			orderId: trade.orderId,
			orderAmount: { value: 5000, currency: "CZK" },
		});
		// trade: 4999.5 for units + 0.5 rounding = 5000 total
		// But if order amount was 7000, fee = 7000 - 4999.5 - 0.5 = 2000
		order.orderAmount.value = 7000;
		const dir = setupDir([trade], [order]);
		const result = importAmundiDirectory(dir);

		// Should have: commodity purchase + fee + rounding = 3 transactions
		expect(result.transactions).toHaveLength(3);

		const fee = result.transactions.find((t) => t.id.startsWith("amundi-fee-"));
		expect(fee?.amount.value).toBe(-2000);
		expect(fee?.category).toBe("Expenses:Finance:Investments:Fees");
		expect(fee?.description).toBe("Vstupn\u00ed poplatek");
	});

	test("generates rounding transaction when orders present", () => {
		const trade = makeTrade(); // rounding: 0.5
		const order = makeOrder({
			orderId: trade.orderId,
			orderAmount: { value: 5000, currency: "CZK" },
		});
		const dir = setupDir([trade], [order]);
		const result = importAmundiDirectory(dir);

		const rounding = result.transactions.find((t) =>
			t.id.startsWith("amundi-round-"),
		);
		expect(rounding?.amount.value).toBe(-0.5);
		expect(rounding?.category).toBe("Income:Investments:Amundi:Rounding");
	});

	test("skips fee when order amount matches trade + rounding", () => {
		const trade = makeTrade(); // 4999.5 + 0.5 = 5000
		const order = makeOrder({
			orderId: trade.orderId,
			orderAmount: { value: 5000, currency: "CZK" },
		});
		const dir = setupDir([trade], [order]);
		const result = importAmundiDirectory(dir);

		const fees = result.transactions.filter((t) =>
			t.id.startsWith("amundi-fee-"),
		);
		expect(fees).toHaveLength(0);
	});

	test("no fee or rounding transactions without orders.json", () => {
		const dir = setupDir([makeTrade()]);
		const result = importAmundiDirectory(dir);

		// Only commodity purchase, no fee/rounding
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]?.commodity).toBeDefined();
	});
});
