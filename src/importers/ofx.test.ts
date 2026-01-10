import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXAMPLES_RAW } from "../config.ts";
import { assertAt, assertDefined } from "../test-utils.ts";
import { importOfxFile, parseOfx } from "./ofx.ts";

const SAMPLE_OFX = `<?xml version="1.0" encoding="utf-8" ?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>

<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>test-uuid</TRNUID>
      <STATUS>
        <CODE>0</CODE>
        <SEVERITY>INFO</SEVERITY>
      </STATUS>
      <STMTRS>
        <CURDEF>CZK</CURDEF>
        <BANKACCTFROM>
          <BANKID>2010</BANKID>
          <ACCTID>123456</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20251201000000.000[+01.00:CET]</DTSTART>
          <DTEND>20251231000000.000[+01.00:CET]</DTEND>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20251201000000.000[+01.00:CET]</DTPOSTED>
            <TRNAMT>1000.00</TRNAMT>
            <FITID>TXN001</FITID>
            <NAME>Salary</NAME>
            <MEMO>Monthly salary</MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20251205000000.000[+01.00:CET]</DTPOSTED>
            <TRNAMT>-50.00</TRNAMT>
            <FITID>TXN002</FITID>
            <NAME>Card Payment</NAME>
            <MEMO>GROCERY STORE</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

describe("parseOfx", () => {
	test("parses statement metadata", () => {
		const result = parseOfx(SAMPLE_OFX);

		expect(result.statement.currency).toBe("CZK");
		expect(result.statement.bankId).toBe("2010");
		expect(result.statement.accountId).toBe("123456");
		expect(result.statement.accountType).toBe("CHECKING");
		expect(result.statement.dateRange.start).toBe("2025-12-01");
		expect(result.statement.dateRange.end).toBe("2025-12-31");
		expect(result.errors).toHaveLength(0);
	});

	test("parses transactions", () => {
		const result = parseOfx(SAMPLE_OFX);
		const { transactions } = result.statement;

		expect(transactions).toHaveLength(2);

		const credit = assertAt(transactions, 0);
		const debit = assertAt(transactions, 1);

		expect(credit.type).toBe("CREDIT");
		expect(credit.date).toBe("2025-12-01");
		expect(credit.amount).toBe(1000);
		expect(credit.fitId).toBe("TXN001");
		expect(credit.name).toBe("Salary");
		expect(credit.memo).toBe("Monthly salary");

		expect(debit.type).toBe("DEBIT");
		expect(debit.date).toBe("2025-12-05");
		expect(debit.amount).toBe(-50);
		expect(debit.fitId).toBe("TXN002");
		expect(debit.memo).toBe("GROCERY STORE");
	});

	test("parses OFX date formats", () => {
		const ofxWithDifferentDates = SAMPLE_OFX.replace(
			"20251201000000.000[+01.00:CET]",
			"20240315120000",
		);
		const result = parseOfx(ofxWithDifferentDates);

		expect(result.statement.dateRange.start).toBe("2024-03-15");
	});

	test("throws on missing STMTRS", () => {
		const badOfx = "<OFX></OFX>";
		expect(() => parseOfx(badOfx)).toThrow("No STMTRS block found");
	});

	test("throws on missing BANKACCTFROM", () => {
		const badOfx = `<OFX>
			<STMTRS>
				<CURDEF>USD</CURDEF>
			</STMTRS>
		</OFX>`;
		expect(() => parseOfx(badOfx)).toThrow("No BANKACCTFROM block found");
	});

	test("throws on missing BANKTRANLIST", () => {
		const badOfx = `<OFX>
			<STMTRS>
				<CURDEF>USD</CURDEF>
				<BANKACCTFROM>
					<BANKID>1234</BANKID>
					<ACCTID>5678</ACCTID>
					<ACCTTYPE>CHECKING</ACCTTYPE>
				</BANKACCTFROM>
			</STMTRS>
		</OFX>`;
		expect(() => parseOfx(badOfx)).toThrow("No BANKTRANLIST block found");
	});

	test("returns error for transaction missing required fields", () => {
		const badOfx = `<OFX>
			<STMTRS>
				<CURDEF>USD</CURDEF>
				<BANKACCTFROM>
					<BANKID>1234</BANKID>
					<ACCTID>5678</ACCTID>
					<ACCTTYPE>CHECKING</ACCTTYPE>
				</BANKACCTFROM>
				<BANKTRANLIST>
					<DTSTART>20251201</DTSTART>
					<DTEND>20251231</DTEND>
					<STMTTRN>
						<TRNTYPE>CREDIT</TRNTYPE>
						<FITID>TXN001</FITID>
					</STMTTRN>
				</BANKTRANLIST>
			</STMTRS>
		</OFX>`;
		const result = parseOfx(badOfx);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("missing required fields");
	});

	test("throws on invalid date format", () => {
		const badOfx = `<OFX>
			<STMTRS>
				<CURDEF>USD</CURDEF>
				<BANKACCTFROM>
					<BANKID>1234</BANKID>
					<ACCTID>5678</ACCTID>
					<ACCTTYPE>CHECKING</ACCTTYPE>
				</BANKACCTFROM>
				<BANKTRANLIST>
					<DTSTART>20251201</DTSTART>
					<DTEND>20251231</DTEND>
					<STMTTRN>
						<TRNTYPE>CREDIT</TRNTYPE>
						<DTPOSTED>invalid-date</DTPOSTED>
						<TRNAMT>100</TRNAMT>
						<FITID>TXN001</FITID>
					</STMTTRN>
				</BANKTRANLIST>
			</STMTRS>
		</OFX>`;
		const result = parseOfx(badOfx);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("Invalid OFX date");
	});
});

describe("importOfxFile", () => {
	test("imports from example file", () => {
		const result = importOfxFile(join(EXAMPLES_RAW, "fio/2025-12.ofx"), {
			accountMapping: {
				"1234567890": { account: "Assets:Test:CZK", currency: "CZK" },
			},
		});

		expect(result.errors).toHaveLength(0);
		expect(result.transactions.length).toBeGreaterThan(0);

		const txn = assertAt(result.transactions, 0);
		expect(txn.account).toBe("Assets:Test:CZK");
		expect(txn.amount.currency).toBe("CZK");
		expect(txn.id).toStartWith("ofx-");
	});

	test("auto-generates account when no mapping provided", () => {
		const result = importOfxFile(
			join(EXAMPLES_RAW, "ofx/other-bank-2025-12.ofx"),
		);

		expect(result.errors).toHaveLength(0);
		expect(result.transactions.length).toBeGreaterThan(0);

		const txn = assertAt(result.transactions, 0);
		// Auto-generated: Assets:Bank-{bankId}:{currency}
		expect(txn.account).toBe("Assets:Bank-9999:EUR");
		expect(txn.amount.currency).toBe("EUR");
	});

	test("uses accountBase when provided", () => {
		const result = importOfxFile(
			join(EXAMPLES_RAW, "ofx/other-bank-2025-12.ofx"),
			{
				accountBase: "Assets:OtherBank",
			},
		);

		expect(result.errors).toHaveLength(0);
		const txn = assertAt(result.transactions, 0);
		// Uses accountBase: {accountBase}:{currency}
		expect(txn.account).toBe("Assets:OtherBank:EUR");
	});

	test("accountMapping takes precedence over accountBase", () => {
		const result = importOfxFile(
			join(EXAMPLES_RAW, "ofx/other-bank-2025-12.ofx"),
			{
				accountBase: "Assets:OtherBank",
				accountMapping: {
					EU12345678: { account: "Assets:Mapped:Account", currency: "EUR" },
				},
			},
		);

		expect(result.errors).toHaveLength(0);
		const txn = assertAt(result.transactions, 0);
		// accountMapping wins
		expect(txn.account).toBe("Assets:Mapped:Account");
	});

	test("uses custom bank prefix", () => {
		const result = importOfxFile(join(EXAMPLES_RAW, "fio/2025-12.ofx"), {
			bankPrefix: "mybank",
			accountMapping: {
				"1234567890": { account: "Assets:Test", currency: "CZK" },
			},
		});

		const txn = assertAt(result.transactions, 0);
		expect(txn.id).toStartWith("mybank-");
	});

	test("returns errors with source file path", () => {
		const result = importOfxFile(join(EXAMPLES_RAW, "ofx/bad-transaction.ofx"));

		expect(result.errors.length).toBeGreaterThan(0);
		const error = assertAt(result.errors, 0);
		expect(error.source).toBe(join(EXAMPLES_RAW, "ofx/bad-transaction.ofx"));
		expect(error.message).toContain("missing required fields");
	});
});

describe("test-utils", () => {
	test("assertDefined returns value when defined", () => {
		const value: string | undefined = "hello";
		const result = assertDefined(value);
		expect(result).toBe("hello");
	});

	test("assertAt returns element at index", () => {
		const arr = ["a", "b", "c"];
		const result = assertAt(arr, 1);
		expect(result).toBe("b");
	});
});
