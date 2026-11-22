import { createDatabase, type Database } from "@ballast/db";
import { runReconciliation, type ReconciliationReport } from "./reconcile.js";

export async function runReconcileCli(
  db?: Database,
): Promise<{ breaks: number; report: ReconciliationReport }> {
  const database = db ?? createDatabase();
  const shouldClose = !db;
  try {
    const result = await runReconciliation(database);
    console.log(JSON.stringify(result.report, null, 2));
    return result;
  } finally {
    if (shouldClose) {
      await database.$client.end().catch(() => {});
    }
  }
}

if (
  process.env.VITEST !== "true" &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("cli.js") ||
    process.argv[1]?.endsWith("cli.ts"))
) {
  runReconcileCli()
    .then(({ breaks }) => {
      process.exit(breaks > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("ledger: reconciliation failed", err);
      process.exit(1);
    });
}
