import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string = process.env.DATABASE_URL ?? "") {
  if (!connectionString) {
    throw new Error("@ballast/db: DATABASE_URL is not set");
  }
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}
