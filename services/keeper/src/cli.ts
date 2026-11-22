import { createKeeperContext, runSingleJob } from "./index.js";
import type { JobResult } from "./jobs/types.js";

export interface CliOptions {
  jobName: string;
  dryRun: boolean;
}

export function parseCliArgs(args: string[]): CliOptions {
  let jobName: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "run") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        jobName = args[++i];
      }
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("-") && !jobName) {
      jobName = arg;
    }
  }

  if (!jobName) {
    throw new Error(
      "Usage: keeper-cli [run] <job-name> [--dry-run]\n" +
        "Available jobs: cure-expiry, repo-unwind, repo-margin, sync-collateral, interest-accrual, balance",
    );
  }

  return { jobName, dryRun };
}

export async function runCli(
  args: string[] = process.argv.slice(2),
  contextFactory = createKeeperContext,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const ctx = await contextFactory();
  try {
    const result: JobResult = await runSingleJob(options.jobName, ctx, { dryRun: options.dryRun });
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`Error running job ${options.jobName}:`, err);
    return 1;
  } finally {
    await Promise.all([ctx.db.$client.end().catch(() => {}), ctx.rawSql.end().catch(() => {})]);
  }
}

if (
  process.env.VITEST !== "true" &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("cli.js") ||
    process.argv[1]?.endsWith("cli.ts"))
) {
  runCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
