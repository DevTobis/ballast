import { createKeeperContext, runSingleJob, KEEPER_JOBS, type KeeperContext } from "./index.js";
import { getLockKey } from "./lock.js";
import type { JobResult } from "./jobs/types.js";

export interface CliOptions {
  jobName: string;
}

export const USAGE_TEXT = `Usage: keeper-cli [run] <job-name>
Available jobs: ${KEEPER_JOBS.join(", ")}`;

/**
 * Parses `[run] <job-name>`. There is deliberately no `--dry-run`: every job signs and submits
 * transactions directly, so a flag that only logged would still move state on chain.
 */
export function parseCliArgs(args: string[]): CliOptions {
  const rest = args[0] === "run" ? args.slice(1) : args;
  if (rest.includes("--dry-run")) {
    throw new Error(
      `--dry-run is not supported: keeper jobs sign and submit transactions directly.\n\n${USAGE_TEXT}`,
    );
  }
  const unknownFlag = rest.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new Error(`Unknown option "${unknownFlag}".\n\n${USAGE_TEXT}`);
  if (rest.length !== 1) throw new Error(USAGE_TEXT);

  const jobName = rest[0];
  if (!(KEEPER_JOBS as readonly string[]).includes(jobName)) {
    throw new Error(`Unknown job "${jobName}".\n\n${USAGE_TEXT}`);
  }
  return { jobName };
}

/**
 * Runs one job and returns the process exit code: 0 when the job ran with no row errors, 1 on a
 * usage error, a job error or crash, or when the job's advisory lock is held (the scheduled
 * keeper is running the same job right now; running it twice would race on the keeper account's
 * sequence number).
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
  contextFactory: () => Promise<KeeperContext> = createKeeperContext,
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
    const lockKey = getLockKey(options.jobName);
    const lock = await ctx.lockProvider.acquire(lockKey);
    if (!lock) {
      console.error(`keeper-cli: ${options.jobName} is already running (advisory lock ${lockKey} held)`);
      return 1;
    }
    try {
      const result: JobResult = await runSingleJob(options.jobName, ctx);
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length > 0 ? 1 : 0;
    } finally {
      try {
        await lock.unlock();
      } finally {
        await lock.release();
      }
    }
  } catch (err) {
    console.error(`keeper-cli: error running job ${options.jobName}:`, err);
    return 1;
  } finally {
    await Promise.all([ctx.db.$client.end().catch(() => {}), ctx.rawSql.end().catch(() => {})]);
  }
}

if (
  process.env.VITEST !== "true" &&
  (process.argv[1]?.endsWith("dist/cli.js") || process.argv[1]?.endsWith("src/cli.ts"))
) {
  runCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
