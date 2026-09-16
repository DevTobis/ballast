import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("@ballast/db: DATABASE_URL is not set");
  }
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./migrations" });
  await sql.end();
  console.log("@ballast/db: migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
