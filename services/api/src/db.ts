import { createDatabase, type Database } from "@ballast/db";

let instance: Database | undefined;

/** Lazily creates the shared Drizzle handle so tests can `vi.mock("@ballast/db")` freely. */
export function getDb(): Database {
  if (!instance) {
    instance = createDatabase();
  }
  return instance;
}
