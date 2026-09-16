import type { Database } from "@ballast/db";

/**
 * A minimal stand-in for the Drizzle `Database` handle, built by hand rather than via
 * `vi.mock("@ballast/db")` — `buildServer()` takes `db`/`contracts` as injectable options
 * specifically so tests never need real Postgres or a real Stellar RPC connection. `fixtures` is
 * keyed by table object identity (e.g. `schema.asset`), so `select().from(schema.asset)` returns
 * whatever rows were registered for that table; `.where()`/`.orderBy()`/`.limit()` are no-ops
 * that keep the same fixture rows (fine for the route-shape assertions these tests care about).
 */
export function createFakeDb(fixtures: Map<unknown, unknown[]>): Database {
  const chain = (rows: unknown[]) => {
    const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    promise.where = () => chain(rows);
    promise.orderBy = () => chain(rows);
    promise.limit = () => chain(rows);
    return promise;
  };

  return {
    select: () => ({
      from: (table: unknown) => chain(fixtures.get(table) ?? []),
    }),
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => [{ id: "fixture-id", ...values }],
      }),
    }),
    update: (_table: unknown) => ({
      set: () => ({ where: async () => [] }),
    }),
  } as unknown as Database;
}
