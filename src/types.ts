/**
 * Core data structures for the finance pipeline.
 * All transforms produce these types. All outputs consume them.
 */

export interface Money {
	/** Positive = inflow, negative = outflow */
	value: number;
	/** ISO currency code: USD, CZK, EUR */
	currency: string;
}

export interface CommodityDefinition {
	/** Symbol used in beancount: CONSEQRE, AMUNDI, etc. */
	symbol: string;
	/** Human-readable name */
	name?: string;
	/** ISIN if applicable */
	isin?: string;
	/** Date when commodity was first used (for open directive) */
	date: string;
}

export interface Location {
	name: string;
	coords?: [number, number]; // [lat, long]
}

export interface Split {
	amount: Money;
	category: string;
	memo?: string;
}

export interface Transaction {
	/** Unique, stable identifier (for overrides, deduplication) */
	id: string;
	/** ISO date: YYYY-MM-DD */
	date: string;
	/** Primary amount in account's currency */
	amount: Money;
	/** Original amount if currency converted (e.g., Revolut USD→CZK payment) */
	originalAmount?: Money;
	/** Raw description from bank (combined or primary) */
	description: string;
	/** Raw name field from source (for rule matching) */
	rawName?: string;
	/** Raw memo field from source (for rule matching) */
	rawMemo?: string;
	/** Normalized payee name (from rules) */
	payee?: string;
	/** Category path: Expenses:Food:Delivery (if not split) */
	category?: string;
	/** Split into multiple categories (if split) */
	splits?: Split[];
	/** Source account: Assets:Revolut:USD */
	account: string;
	/** Location if known (from payee data or manual) */
	location?: Location;
	/** Tags: recurring, reimbursable, etc. */
	tags?: string[];
	/** Which raw file this came from */
	source: string;
	/** Transaction is pending/uncleared (beancount: !) */
	pending?: boolean;
	/** Memo/notes (from YNAB or manual) */
	memo?: string;
	/** Arbitrary metadata */
	metadata?: Record<string, unknown>;
	/** Transfer to another account (for currency exchanges, internal transfers) */
	transfer?: {
		/** Destination account: Assets:Revolut:GBP */
		toAccount: string;
		/** Amount in destination currency */
		toAmount: Money;
	};
	/**
	 * Commodity purchase or sale.
	 * When set, the counter-posting uses commodity units at cost instead of
	 * a simple auto-balanced category posting.
	 *
	 * txn.account + txn.amount = cash side
	 * commodity.account + commodity.units SYMBOL {costPerUnit} = commodity side
	 */
	commodity?: {
		/** Account holding the commodity: Assets:Investments:Conseq */
		account: string;
		/** Commodity symbol: CONSEQRE */
		symbol: string;
		/** Number of units purchased (positive) or sold (negative) */
		units: number;
		/** Cost per unit at time of purchase */
		costPerUnit: Money;
	};
}

export interface Account {
	/** Full path: Assets:Revolut:USD */
	name: string;
	/** Account type for double-entry */
	type: "asset" | "liability" | "income" | "expense" | "equity";
	/** Primary currency (optional, some accounts are multi-currency) */
	currency?: string;
	/** Opening date */
	opened?: string;
	/** Closing date (if closed) */
	closed?: string;
}

export interface BalanceAssertion {
	/** ISO date */
	date: string;
	/** Account path */
	account: string;
	/** Expected balance */
	balance: Money;
	/** Source of this assertion (bank statement, manual check) */
	source?: string;
}

export interface Price {
	/** ISO date: YYYY-MM-DD */
	date: string;
	/** Base currency (what you're pricing): e.g., EUR */
	baseCurrency: string;
	/** Quote currency (price denominated in): e.g., CZK */
	quoteCurrency: string;
	/** Price: 1 baseCurrency = price quoteCurrency */
	price: number;
	/** Source of this price (for traceability) */
	source?: string;
}

export interface Rule<C extends string = string> {
	/** Regex pattern(s) to match against name OR memo (either matches = pass) */
	match?: RegExp | RegExp[];
	/** Regex pattern to match only against raw name field */
	matchName?: RegExp;
	/** Regex pattern to match only against raw memo field */
	matchMemo?: RegExp;
	/**
	 * Match against metadata fields (bank-specific).
	 * Keys are metadata field names, values are regex patterns.
	 * All specified fields must match.
	 * @example { variableSymbol: /^1234/, counterAccount: /^CZ/ }
	 */
	matchMetadata?: Record<string, RegExp>;
	/**
	 * Custom matcher function for complex logic.
	 * Receives the full transaction, returns true if rule should apply.
	 * Use as escape hatch when patterns aren't enough.
	 * @example (txn) => txn.amount.value > 1000 && txn.metadata?.variableSymbol === "123"
	 */
	matchFn?: (txn: Transaction) => boolean;
	/** Category to assign */
	category?: C;
	/** Normalized payee name */
	payee?: string;
	/** Known locations for this payee */
	locations?: Location[];
	/** Tags to add */
	tags?: string[];
	/** Recurring interval if this is a subscription */
	recurring?: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
}

export interface Override<C extends string = string> {
	/** Transaction ID to override */
	id: string;
	/** Override category */
	category?: C;
	/** Override payee */
	payee?: string;
	/** Override/add tags */
	tags?: string[];
	/** Override memo */
	memo?: string;
	/** Skip this transaction entirely (exclude from output) */
	skip?: boolean;
}

export interface ImportResult {
	transactions: Transaction[];
	errors: ImportError[];
	/** Balance assertions extracted from import source (end-of-period) */
	balanceAssertions?: BalanceAssertion[];
	/** Opening balances extracted from import source (start-of-period) */
	openingBalances?: BalanceAssertion[];
	/** Price/exchange rate data extracted from import source */
	prices?: Price[];
	/** Commodity definitions (for `commodity` directives in beancount) */
	commodities?: CommodityDefinition[];
	/**
	 * Raw beancount content to include as a supplementary file.
	 * Escape hatch for constructs the Transaction type can't express.
	 * Written as a separate file and included via `include` directive.
	 */
	supplementaryBeancount?: string;
}

export interface ImportError {
	source: string;
	line?: number;
	message: string;
	raw?: string;
}
