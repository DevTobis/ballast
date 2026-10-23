import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { SCREENING_TTL_MS, checkParty } from "../compliance/gate.js";
import { OfacScreener, ScreeningUnavailableError, type SanctionsScreener } from "../compliance/screener.js";
import { SanctionsList, nameKey, parseCsv } from "../compliance/sanctionsList.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";

// Three real rows from OFAC's SDN.CSV (a Cuban bank with an a.k.a., the Lazarus Group with its
// published ETH addresses, an individual) and two from ALT.CSV, copied verbatim.
const fixture = (name: string) => readFileSync(new URL(`../compliance/__fixtures__/${name}`, import.meta.url), "utf8");
const SDN = fixture("sdn-sample.csv");
const ALT = fixture("alt-sample.csv");
const LAZARUS_ETH = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas and CRLF", () => {
    expect(parseCsv('a,"b,c",""\nx,"y ""q"" z",\r\n,,\n')).toEqual([
      ["a", "b,c", ""],
      ["x", 'y "q" z', ""],
      ["", "", ""],
    ]);
  });
});

describe("nameKey", () => {
  it("ignores case, punctuation, word order and legal-form suffixes", () => {
    expect(nameKey("MESRI, Behzad")).toBe(nameKey("behzad mesri"));
    expect(nameKey("Acme Capital Ltd.")).toBe(nameKey("ACME CAPITAL LIMITED"));
  });

  it("does not make different names equal", () => {
    expect(nameKey("Acme Capital")).not.toBe(nameKey("Acme Holdings"));
  });
});

describe("SanctionsList on real OFAC rows", () => {
  const list = new SanctionsList(SDN, ALT);

  it("matches a listed name, an a.k.a. in the remarks and an ALT.CSV alias", () => {
    expect(list.screen({ legalName: "Banco Nacional de Cuba" })).toEqual([
      { type: "name", listed: "BANCO NACIONAL DE CUBA", entNum: "306" },
    ]);
    expect(list.screen({ legalName: "NATIONAL BANK OF CUBA" }).map((m) => m.entNum)).toEqual(["306"]);
    expect(list.screen({ legalName: "Abu Abbas" }).map((m) => m.entNum)).toEqual(["2674"]);
  });

  it("matches a published digital-currency address, whatever its case", () => {
    expect(list.screen({ stellarAccounts: [LAZARUS_ETH.toLowerCase()] })).toEqual([
      { type: "address", listed: `ETH ${LAZARUS_ETH}`, entNum: "27307" },
    ]);
  });

  it("returns nothing for an unlisted party", () => {
    expect(list.screen({ legalName: "Ballast Treasury Partners Ltd", stellarAccounts: ["GABCDEFTESTACCOUNT"] })).toEqual([]);
  });
});

describe("OfacScreener", () => {
  const filler = Array.from({ length: 1200 }, (_, i) => `${100000 + i},"FILLER ENTITY ${i}",-0- ,"TEST",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `).join("\n");
  const bigSdn = `${filler}\n${SDN}`;
  const respond = (body: string, status = 200) => new Response(body, { status });

  it("downloads once, screens, and refreshes only after the refresh interval", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (url: string) => respond(url.includes("ALT") ? ALT : bigSdn)) as unknown as typeof fetch;
    const screener = new OfacScreener({ fetchImpl, now: () => now, refreshMs: 1000, sdnUrl: "https://x/SDN.CSV", altUrl: "https://x/ALT.CSV" });

    const first = await screener.screen({ legalName: "Banco Nacional de Cuba" });
    expect(first.matches).toHaveLength(1);
    expect(first.listSource).toBe("OFAC SDN");
    await screener.screen({ legalName: "x" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // SDN + ALT, once

    now = 1500;
    await screener.screen({ legalName: "x" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("keeps screening against the last good copy when a refresh fails, until it is too old", async () => {
    let now = 0;
    let fail = false;
    const fetchImpl = (async (url: string) => (fail ? respond("down", 503) : respond(url.includes("ALT") ? ALT : bigSdn))) as unknown as typeof fetch;
    const screener = new OfacScreener({ fetchImpl, now: () => now, refreshMs: 1000, maxAgeMs: 10_000, sdnUrl: "https://x/SDN.CSV", altUrl: "https://x/ALT.CSV" });
    await screener.screen({ legalName: "x" });

    fail = true;
    now = 5000;
    await expect(screener.screen({ legalName: "Banco Nacional de Cuba" })).resolves.toMatchObject({ matches: [expect.anything()] });
    now = 11_000;
    await expect(screener.screen({ legalName: "x" })).rejects.toBeInstanceOf(ScreeningUnavailableError);
  });

  it("fails closed when the list has never loaded, and rejects a truncated download", async () => {
    const down = new OfacScreener({ fetchImpl: (async () => respond("nope", 500)) as unknown as typeof fetch });
    await expect(down.screen({ legalName: "x" })).rejects.toBeInstanceOf(ScreeningUnavailableError);

    const truncated = new OfacScreener({ fetchImpl: (async () => respond(SDN)) as unknown as typeof fetch });
    await expect(truncated.screen({ legalName: "x" })).rejects.toThrow(/truncated/);
  });
});

/** Stateful fake for the tables the gate touches. */
function gateDb(party: Record<string, unknown> | null, existingChecks: Array<Record<string, unknown>> = []) {
  const checks = [...existingChecks];
  const audits: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    p.where = () => chain(rows);
    p.orderBy = () => chain(rows);
    p.limit = () => chain(rows);
    return p;
  };
  const db = {
    select: () => ({
      from: (t: unknown) =>
        t === schema.party ? chain(party ? [party] : [])
        : t === schema.partyAccount ? chain([{ partyId: "p1", stellarAccount: "GACCOUNT" }])
        : t === schema.complianceCheck ? chain([...checks].sort((a, b) => (b.checkedAt as Date).getTime() - (a.checkedAt as Date).getTime()))
        : chain([]),
    }),
    insert: (t: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if (t === schema.complianceCheck) checks.unshift(v);
        if (t === schema.auditLog) audits.push(v);
      },
    }),
  } as unknown as Database;
  return { db, checks, audits };
}

const clean: SanctionsScreener = { screen: async () => ({ matches: [], listSource: "OFAC SDN", listLoadedAt: new Date() }) };
const approved = { id: "p1", legalName: "Ballast Treasury Partners Ltd", kybStatus: "approved" };

describe("checkParty", () => {
  it("passes an approved, clear party and records the screening", async () => {
    const { db, checks } = gateDb(approved);
    expect(await checkParty(db, clean, "p1")).toBeNull();
    expect(checks[0]).toMatchObject({ partyId: "p1", result: "clear", listSource: "OFAC SDN" });
  });

  it.each(["pending", "rejected"])("blocks a party whose KYB is %s, without screening", async (kybStatus) => {
    const { db } = gateDb({ ...approved, kybStatus });
    const screen = vi.fn();
    const hold = await checkParty(db, { screen } as unknown as SanctionsScreener, "p1");
    expect(hold).toMatchObject({ status: 403, error: expect.stringContaining(`KYB is ${kybStatus}`) });
    expect(screen).not.toHaveBeenCalled();
  });

  it("blocks and audits a sanctions match, and keeps blocking on later calls", async () => {
    const { db, checks, audits } = gateDb(approved);
    const hit: SanctionsScreener = {
      screen: async () => ({ matches: [{ type: "name", listed: "ACME", entNum: "9" }], listSource: "OFAC SDN", listLoadedAt: new Date() }),
    };
    expect(await checkParty(db, hit, "p1")).toMatchObject({ status: 403 });
    expect(checks[0]).toMatchObject({ result: "match" });
    expect(audits[0]).toMatchObject({ action: "sanctions.match" });

    // Even a screener that now says clear does not lift a hold: a person has to review it.
    expect(await checkParty(db, clean, "p1")).toMatchObject({ status: 403, error: expect.stringContaining("needs review") });
  });

  it("reuses a recent clear screening and re-screens once it is older than the TTL", async () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const screen = vi.fn(clean.screen);
    const recent = gateDb(approved, [{ partyId: "p1", kind: "sanctions", result: "clear", checkedAt: new Date(now.getTime() - 1000) }]);
    expect(await checkParty(recent.db, { screen }, "p1", now)).toBeNull();
    expect(screen).not.toHaveBeenCalled();

    const old = gateDb(approved, [{ partyId: "p1", kind: "sanctions", result: "clear", checkedAt: new Date(now.getTime() - SCREENING_TTL_MS - 1) }]);
    expect(await checkParty(old.db, { screen }, "p1", now)).toBeNull();
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it("does not hold a party after 25 hours if the match was cleared manually, but holds if a new match appears", async () => {
    const t0 = new Date("2026-10-08T10:00:00Z");
    const t1 = new Date("2026-10-08T11:00:00Z"); // cleared manually 1h later
    const t25 = new Date("2026-10-09T12:00:00Z"); // 25 hours later (26h after t0)

    const matchHistory = [
      {
        partyId: "p1",
        kind: "sanctions",
        result: "clear",
        matches: [],
        listSource: "manual review by alice: different entity, same name",
        checkedAt: t1,
      },
      {
        partyId: "p1",
        kind: "sanctions",
        result: "match",
        matches: [{ type: "name", listed: "ACME CORP", entNum: "999" }],
        listSource: "OFAC SDN",
        checkedAt: t0,
      },
    ];

    const { db, checks } = gateDb(approved, matchHistory);

    // Screener still returns the same false positive match (entNum 999)
    const screenerSameMatch: SanctionsScreener = {
      screen: async () => ({
        matches: [{ type: "name", listed: "ACME CORP", entNum: "999" }],
        listSource: "OFAC SDN",
        listLoadedAt: t25,
      }),
    };

    // After 25 hours, gate should re-screen but pass because entNum 999 was cleared manually
    expect(await checkParty(db, screenerSameMatch, "p1", t25)).toBeNull();
    expect(checks[0].result).toBe("clear");

    // If a brand new match (entNum 1000) appears, party must be held again
    // Must be at least SCREENING_TTL_MS after the previous check at t25
    const t26 = new Date(t25.getTime() + SCREENING_TTL_MS + 1000);
    const screenerNewMatch: SanctionsScreener = {
      screen: async () => ({
        matches: [
          { type: "name", listed: "ACME CORP", entNum: "999" },
          { type: "name", listed: "OTHER ENTITY", entNum: "1000" },
        ],
        listSource: "OFAC SDN",
        listLoadedAt: t26,
      }),
    };

    const hold = await checkParty(db, screenerNewMatch, "p1", t26);
    expect(hold).toMatchObject({ status: 403, error: expect.stringContaining("needs review") });
    expect(checks[0].result).toBe("match");
  });

  it("answers 503, not a pass, when the sanctions list cannot be loaded", async () => {
    const { db } = gateDb(approved);
    const broken: SanctionsScreener = { screen: async () => { throw new ScreeningUnavailableError("sanctions list unavailable: down"); } };
    expect(await checkParty(db, broken, "p1")).toEqual({ status: 503, error: "sanctions list unavailable: down" });
  });

  it("screens the party's name and every account it holds", async () => {
    const { db } = gateDb(approved);
    const screen = vi.fn(clean.screen);
    await checkParty(db, { screen }, "p1");
    expect(screen).toHaveBeenCalledWith({ legalName: "Ballast Treasury Partners Ltd", stellarAccounts: ["GACCOUNT"] });
  });

  it("blocks an unknown party", async () => {
    expect(await checkParty(gateDb(null).db, clean, "ghost")).toMatchObject({ status: 403 });
  });
});

describe("compliance in front of the routes", () => {
  const config: ApiConfig = {
    port: 0, jwtSigningSecret: "test-signing-key",
    sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
    networkPassphrase: "Test SDF Network ; September 2015",
    webhookSecretKey: "00".repeat(32), apiKeySecretKey: "00".repeat(32),
    complianceEnforced: true, consoleOrigin: "http://localhost:5173",
  };
  const bearer = { authorization: `Bearer ${signSessionToken("GACCOUNT", config.jwtSigningSecret)}` };
  const server = (screener: SanctionsScreener, party: Record<string, unknown> | null = approved) =>
    buildServer({ config, db: gateDb(party).db, contracts: {} as ContractClients, screener });

  it("turns a sanctioned caller away before the handler runs", async () => {
    const hit: SanctionsScreener = { screen: async () => ({ matches: [{ type: "name", listed: "X", entNum: "1" }], listSource: "OFAC SDN", listLoadedAt: new Date() }) };
    const res = await server(hit).inject({ method: "POST", url: "/v1/credit-lines/abc/fund", headers: bearer, payload: { amount: "1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/compliance hold/);
  });

  it("does not gate reads, repayments or withdrawals", async () => {
    const screen = vi.fn(clean.screen);
    const app = server({ screen });
    await app.inject({ method: "GET", url: "/v1/api-keys", headers: bearer });
    await app.inject({ method: "POST", url: "/v1/credit-lines/abc/repayments", headers: bearer, payload: { amount: "1" } });
    await app.inject({ method: "POST", url: "/v1/credit-lines/abc/withdrawals", headers: bearer, payload: { kind: "undrawn", amount: "1" } });
    expect(screen).not.toHaveBeenCalled();
  });

  it("screens the borrower named on a new credit line as well as the caller", async () => {
    const screen = vi.fn(clean.screen);
    await server({ screen }).inject({
      method: "POST", url: "/v1/credit-lines", headers: bearer,
      payload: { lenderId: "p1", borrowerId: "p2" },
    });
    // The fake serves one party row whatever the id, so what this pins is that a request naming a
    // borrower still passes through the gate (the caller's "clear" is reused for the TTL, so the
    // screener runs once for the first party looked up).
    expect(screen).toHaveBeenCalledTimes(1);
  });
});
