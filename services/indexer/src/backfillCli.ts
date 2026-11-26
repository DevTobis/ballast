import { backfillFromDataLake } from "./backfill.js";

export interface BackfillCliOptions {
  from: number;
  to: number;
  source: "rpc" | "lake";
}

export const USAGE_TEXT = `Usage: pnpm backfill --from <start> --to <end> [--source rpc|lake]
Options:
  --from    Starting ledger sequence (positive integer)
  --to      Ending ledger sequence (positive integer >= from)
  --source  Backfill source: 'rpc' or 'lake' (default: 'rpc')`;

export function parseBackfillArgs(args: string[]): BackfillCliOptions {
  let from: number | undefined;
  let to: number | undefined;
  let source: "rpc" | "lake" = "rpc";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from" && i + 1 < args.length) {
      const val = Number(args[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`Invalid --from value "${args[i]}": must be a positive integer.\n\n${USAGE_TEXT}`);
      }
      from = val;
    } else if (arg === "--to" && i + 1 < args.length) {
      const val = Number(args[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`Invalid --to value "${args[i]}": must be a positive integer.\n\n${USAGE_TEXT}`);
      }
      to = val;
    } else if (arg === "--source" && i + 1 < args.length) {
      const val = args[++i].toLowerCase();
      if (val !== "rpc" && val !== "lake") {
        throw new Error(`Invalid --source value "${val}": must be 'rpc' or 'lake'.\n\n${USAGE_TEXT}`);
      }
      source = val;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE_TEXT);
    } else {
      throw new Error(`Unknown argument "${arg}".\n\n${USAGE_TEXT}`);
    }
  }

  if (from === undefined || to === undefined) {
    throw new Error(`Missing required arguments: both --from and --to are required.\n\n${USAGE_TEXT}`);
  }

  if (from > to) {
    throw new Error(`Invalid range: --from (${from}) must be less than or equal to --to (${to}).\n\n${USAGE_TEXT}`);
  }

  return { from, to, source };
}

export async function runBackfillCli(
  args: string[] = process.argv.slice(2),
  lakeRunner = backfillFromDataLake,
): Promise<number> {
  let options: BackfillCliOptions;
  try {
    options = parseBackfillArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const count = options.to - options.from + 1;
  console.log(
    `Planning backfill of ${count} ledgers (${options.from} to ${options.to}) from source: ${options.source}`,
  );

  if (options.source === "lake") {
    try {
      await lakeRunner(options.from, options.to);
    } catch (err) {
      console.error(`Backfill failed: ${(err as Error).message}`);
      return 1;
    }
  } else {
    console.log(`Backfill plan generated for RPC range ${options.from}..${options.to}`);
  }

  return 0;
}

if (
  process.env.VITEST !== "true" &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("backfillCli.js") ||
    process.argv[1]?.endsWith("backfillCli.ts"))
) {
  runBackfillCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
