import { describe, expect, it } from "vitest";
import { REPORT_CSV_FALLBACK_COLUMNS, toCsv } from "../routes/reports.js";

describe("toCsv", () => {
  it("emits the header line only for an empty row set", () => {
    const csv = toCsv([]);
    expect(csv).toBe(REPORT_CSV_FALLBACK_COLUMNS.join(","));
  });

  it("builds an ordered union of columns across all row kinds with kind first", () => {
    const marginEventRow = {
      id: "m-1",
      kind: "margin_event",
      creditLineId: "cl-1",
      fromState: "healthy",
      toState: "warning",
      ltvBps: 7500,
    };

    const drawRow = {
      id: "d-1",
      kind: "draw",
      creditLineId: "cl-1",
      amount: "1000",
      txHash: "0xabc",
      ledger: 12345,
    };

    const csv = toCsv([marginEventRow, drawRow]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(3);

    // Header has kind first and includes all keys from both margin event and draw
    const headerCols = lines[0].split(",");
    expect(headerCols[0]).toBe("kind");
    expect(headerCols).toContain("id");
    expect(headerCols).toContain("creditLineId");
    expect(headerCols).toContain("fromState");
    expect(headerCols).toContain("toState");
    expect(headerCols).toContain("ltvBps");
    expect(headerCols).toContain("amount");
    expect(headerCols).toContain("txHash");
    expect(headerCols).toContain("ledger");

    // Margin event row should have its values and blanks for draw-only fields
    const parsedMarginRow = lines[1].split(",");
    const amountIdx = headerCols.indexOf("amount");
    const ltvBpsIdx = headerCols.indexOf("ltvBps");
    expect(parsedMarginRow[amountIdx]).toBe('""');
    expect(parsedMarginRow[ltvBpsIdx]).toBe("7500");

    // Draw row should have its values and blanks for margin-event-only fields
    const parsedDrawRow = lines[2].split(",");
    expect(parsedDrawRow[amountIdx]).toBe('"1000"');
    expect(parsedDrawRow[ltvBpsIdx]).toBe('""');
  });

  it("handles rows without a kind column without forcing an empty kind header", () => {
    const rows = [
      { a: 1, b: 2 },
      { b: 3, c: 4 },
    ];
    const csv = toCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("a,b,c");
    expect(lines[1]).toBe('1,2,""');
    expect(lines[2]).toBe('"",3,4');
  });
});
