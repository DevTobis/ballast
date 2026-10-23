import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Param, SQL } from "drizzle-orm";
import { schema } from "@ballast/db";
import { buildServer } from "./index.js";

const TOKEN = "gateway-test-token-0123456789abcdef0123456789";

type Row = Record<string, unknown>;

/** Every value bound in a drizzle `eq`/`and` condition. */
function boundValues(condition: unknown): unknown[] {
  if (condition instanceof Param) return [condition.value];
  if (condition instanceof SQL) return condition.queryChunks.flatMap(boundValues);
  return [];
}
const matches = (row: Row, condition: unknown) => boundValues(condition).every((v) => Object.values(row).includes(v));
const sameKey = (a: Row, b: Row) =>
  a.issuerCode === b.issuerCode && a.route === b.route && a.idempotencyKey === b.idempotencyKey;

/**
 * In-memory stand-in for the slice of `Database` the gateway touches: `audit_log` inserts and the
 * `issuer_idempotency` table (primary-key conflict on insert, `eq`/`and` filters on read, update
 * and delete). `failUpdate` / `failDelete` make those statements throw.
 */
function fakeDb() {
  const tables = new Map<unknown, Row[]>();
  const rowsOf = (table: unknown): Row[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const state = { failUpdate: false, failDelete: false };
  const thenable = <T>(run: () => T, extra: object = {}) =>
    Object.assign({ then: (ok: (v: T) => unknown, ko: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, ko) }, extra);

  const db = {
    insert: (table: unknown) => ({
      values: (row: Row) => {
        const full: Row = table === schema.issuerIdempotency ? { status: "in_flight", response: null, ...row } : { ...row };
        return thenable(() => { rowsOf(table).push(full); }, {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (rowsOf(table).some((r) => sameKey(r, full))) return [];
              rowsOf(table).push(full);
              return [{ key: full.idempotencyKey }];
            },
          }),
        });
      },
    }),
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => ({
          limit: async (n: number) =>
            rowsOf(table)
              .filter((r) => matches(r, condition))
              .slice(0, n)
              .map((r) => Object.fromEntries(Object.keys(fields).map((k) => [k, r[k]]))),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: async (condition: unknown) => {
          if (state.failUpdate) throw new Error("connection reset");
          for (const r of rowsOf(table).filter((r) => matches(r, condition))) Object.assign(r, set);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        if (state.failDelete) throw new Error("connection reset");
        tables.set(table, rowsOf(table).filter((r) => !matches(r, condition)));
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, state, keys: () => rowsOf(schema.issuerIdempotency), audits: () => rowsOf(schema.auditLog) };
}

let issuerCalls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
let issuerStatus: number;
let issuerGate: Promise<void> | null;

beforeEach(() => {
  for (const issuer of ["SPIKO", "ETHERFUSE", "FRANKLIN"]) {
    vi.stubEnv(`${issuer}_API_BASE_URL`, `https://api.${issuer.toLowerCase()}.example`);
    vi.stubEnv(`${issuer}_API_KEY`, "test-key");
  }
  issuerCalls = [];
  issuerStatus = 200;
  issuerGate = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      issuerCalls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      if (issuerGate) await issuerGate;
      if (issuerStatus !== 200) return new Response("issuer unavailable", { status: issuerStatus });
      const n = issuerCalls.length;
      const body = url.endsWith("/v1/liens")
        ? { lienRef: `lien-${n}` }
        : { redemptionRef: `redeem-${n}`, expectedSettlementAt: 1_900_000_000 + n };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const freeze = { assetCode: "BENJI", holderAddress: "GHOLDER", units: "1000000" };
const redeem = { assetCode: "CETES", units: "500000", destination: "GDEST" };

function post(app: ReturnType<typeof buildServer>, path: string, payload: object, key?: string) {
  return app.inject({
    method: "POST",
    url: `/internal/issuers/${path}`,
    headers: { "x-internal-token": TOKEN, ...(key === undefined ? {} : { "idempotency-key": key }) },
    payload,
  });
}

describe("Idempotency-Key on lien-freeze and redeem", () => {
  it.each([
    ["franklin/lien-freeze", freeze, { lienRef: "lien-1" }],
    ["etherfuse/redeem", redeem, { redemptionRef: "redeem-1", expectedSettlementAt: 1_900_000_001 }],
  ])("%s: a second request with the same key returns the first result and does not call the issuer", async (path, payload, first) => {
    const { db, keys, audits } = fakeDb();
    const app = buildServer(db, TOKEN);

    const a = await post(app, path, payload, "order-42");
    const b = await post(app, path, payload, "order-42");

    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(first);
    expect(a.headers["idempotent-replayed"]).toBeUndefined();
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(first);
    expect(b.headers["idempotent-replayed"]).toBe("true");

    expect(issuerCalls).toHaveLength(1);
    expect(issuerCalls[0].headers["Idempotency-Key"]).toBe("order-42");
    expect(keys()).toEqual([expect.objectContaining({ idempotencyKey: "order-42", status: "completed", response: first })]);
    // Only the call that reached the issuer is audited, and it records the key.
    expect(audits()).toHaveLength(1);
    expect(audits()[0].payload).toMatchObject({ idempotencyKey: "order-42", result: first });
  });

  it("answers 422 for the same key with different parameters, without calling the issuer again", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    await post(app, "franklin/lien-freeze", freeze, "k1");
    for (const changed of [{ units: "1000001" }, { holderAddress: "GOTHER" }, { assetCode: "OTHER" }]) {
      const res = await post(app, "franklin/lien-freeze", { ...freeze, ...changed }, "k1");
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/already used for a different lien-freeze request/);
    }
    const redeemRes = await post(app, "etherfuse/redeem", redeem, "k2");
    expect(redeemRes.statusCode).toBe(200);
    expect((await post(app, "etherfuse/redeem", { ...redeem, destination: "GELSEWHERE" }, "k2")).statusCode).toBe(422);

    expect(issuerCalls).toHaveLength(2);
  });

  it("treats units written differently but equal as the same request", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    await post(app, "franklin/lien-freeze", freeze, "k1");
    const res = await post(app, "franklin/lien-freeze", { ...freeze, units: "0001000000" }, "k1");

    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(issuerCalls).toHaveLength(1);
  });

  it("scopes a key to its issuer and route", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    expect((await post(app, "franklin/lien-freeze", freeze, "shared")).json()).toEqual({ lienRef: "lien-1" });
    expect((await post(app, "spiko/lien-freeze", freeze, "shared")).json()).toEqual({ lienRef: "lien-2" });
    expect((await post(app, "franklin/redeem", redeem, "shared")).statusCode).toBe(200);
    // The issuer code in the path is case-insensitive, as getAdapter is.
    expect((await post(app, "FRANKLIN/lien-freeze", freeze, "shared")).headers["idempotent-replayed"]).toBe("true");

    expect(issuerCalls).toHaveLength(3);
  });

  it("without a key behaves as before: every request reaches the issuer, no key is stored or forwarded", async () => {
    const { db, keys, audits } = fakeDb();
    const app = buildServer(db, TOKEN);

    expect((await post(app, "franklin/lien-freeze", freeze)).json()).toEqual({ lienRef: "lien-1" });
    expect((await post(app, "franklin/lien-freeze", freeze)).json()).toEqual({ lienRef: "lien-2" });

    expect(issuerCalls).toHaveLength(2);
    expect(issuerCalls.every((c) => !("Idempotency-Key" in c.headers))).toBe(true);
    expect(keys()).toHaveLength(0);
    expect(audits()).toHaveLength(2);
  });

  it("releases the key when the issuer call fails, so a retry with it reaches the issuer", async () => {
    const { db, keys } = fakeDb();
    const app = buildServer(db, TOKEN);

    issuerStatus = 503;
    expect((await post(app, "etherfuse/redeem", redeem, "retry-me")).statusCode).toBe(500);
    expect(keys()).toHaveLength(0);

    issuerStatus = 200;
    const res = await post(app, "etherfuse/redeem", redeem, "retry-me");
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(issuerCalls).toHaveLength(2);
    expect(issuerCalls.map((c) => c.headers["Idempotency-Key"])).toEqual(["retry-me", "retry-me"]);
  });

  it("answers 409 while the first request with the key is still waiting on the issuer", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);
    let open!: () => void;
    issuerGate = new Promise((resolve) => (open = resolve));

    const first = post(app, "franklin/lien-freeze", freeze, "slow");
    await vi.waitFor(() => expect(issuerCalls).toHaveLength(1));
    const second = await post(app, "franklin/lien-freeze", freeze, "slow");
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/still in progress/);

    open();
    expect((await first).statusCode).toBe(200);
    expect((await post(app, "franklin/lien-freeze", freeze, "slow")).headers["idempotent-replayed"]).toBe("true");
    expect(issuerCalls).toHaveLength(1);
  });

  it("still returns the issuer's result if storing it fails, logs it, and refuses a retry with 409 rather than calling again", async () => {
    const { db, state } = fakeDb();
    const logger = { error: vi.fn() };
    const app = buildServer(db, TOKEN, logger);
    state.failUpdate = true;

    const res = await post(app, "franklin/lien-freeze", freeze, "k1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lienRef: "lien-1" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "store", issuerCode: "franklin", route: "lien-freeze", idempotencyKey: "k1" }),
      expect.stringContaining("could not store the result"),
    );
    expect((await post(app, "franklin/lien-freeze", freeze, "k1")).statusCode).toBe(409);
    expect(issuerCalls).toHaveLength(1);
  });

  it("surfaces the issuer's error, not the release failure, when both fail", async () => {
    const { db, state } = fakeDb();
    const logger = { error: vi.fn() };
    const app = buildServer(db, TOKEN, logger);
    issuerStatus = 503;
    state.failDelete = true;

    const res = await post(app, "franklin/lien-freeze", freeze, "k1");

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/503/);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stage: "release" }), expect.stringContaining("release"));
  });

  it("refuses an unusable key with 400 before calling the issuer", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    for (const key of ["", "has space", "x".repeat(256), "café"]) {
      const res = await post(app, "franklin/lien-freeze", freeze, key);
      expect(res.statusCode, JSON.stringify(key)).toBe(400);
    }
    expect(issuerCalls).toHaveLength(0);
  });
});
