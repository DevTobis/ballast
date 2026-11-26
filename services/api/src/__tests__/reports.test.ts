import { describe, expect, it } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";
import { REPORT_CSV_FALLBACK_COLUMNS, toCsv } from "../routes/reports.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  webhookSecretKey: "00".repeat(32),
  apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false,
  consoleOrigin: "http://localhost:5173",
};

const PARTY = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "GCLIENT11111111111111111111111111111111111111111111111111";
const authed = { authorization: `Bearer ${signSessionToken(ACCOUNT, config.jwtSigningSecret)}` };

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

describe("GET /v1/reports/daily", () => {
  const line = { id: "line-1", lenderId: PARTY, borrowerId: "borrower-1" };
  const draw = {
    id: "draw-1",
    creditLineId: "line-1",
    amount: "100.0000000",
    createdAt: new Date("2026-10-03T10:00:00Z"),
  };
  const app = buildServer({
    config,
    contracts: {} as ContractClients,
    db: createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: PARTY, stellarAccount: ACCOUNT, role: "lender" }]],
        [schema.creditLine, [line]],
        [schema.draw, [draw]],
        [schema.marginEvent, []],
        [schema.liquidation, []],
        [schema.repayment, []],
        [schema.priceSnapshot, []],
      ]),
    ),
  });

  it("returns all rows within a 7-day range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/daily?from=2026-10-01&to=2026-10-07",
      headers: authed,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe("2026-10-01");
    expect(body.to).toBe("2026-10-07");
    expect(body.draws).toHaveLength(1);
    expect(body.draws[0].id).toBe("draw-1");
  });

  it("rejects date range exceeding 31 days with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/daily?from=2026-10-01&to=2026-11-05",
      headers: authed,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("31 days");
  });

  it("sets CSV download headers for format=csv", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/daily?from=2026-10-01&to=2026-10-07&format=csv",
      headers: authed,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="ballast-daily-2026-10-01-to-2026-10-07.csv"',
    );
  });

  it("rejects date combined with from/to instead of silently ignoring the range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/daily?date=2026-10-01&from=2026-10-01&to=2026-10-07",
      headers: authed,
    });
    expect(res.statusCode).toBe(400);
  });
});
