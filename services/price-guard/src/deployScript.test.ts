import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptRelative = "scripts/deploy-mainnet-prices.sh";

function runScript(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [scriptRelative, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("scripts/deploy-mainnet-prices.sh argument handling", () => {
  it("prints usage and exits 0 on --help", () => {
    const res = runScript(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: scripts/deploy-mainnet-prices.sh");
    expect(res.stdout).toContain("--dry-run");
  });

  it("prints usage and exits 0 on -h", () => {
    const res = runScript(["-h"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: scripts/deploy-mainnet-prices.sh");
  });

  it("exits 2 on mistyped flag --dryrun and sends nothing", () => {
    const res = runScript(["--dryrun"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("Unknown option: --dryrun");
    expect(res.stderr).toContain("Usage: scripts/deploy-mainnet-prices.sh");
  });

  it("exits 2 on --dryrun even when CONFIRM_MAINNET is set", () => {
    const res = runScript(["--dryrun"], { CONFIRM_MAINNET: "deploy-prices" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("Unknown option: --dryrun");
  });

  it("exits 2 when an unknown option is passed alongside --dry-run", () => {
    const resAfter = runScript(["--dry-run", "--unknown"]);
    expect(resAfter.status).toBe(2);
    expect(resAfter.stderr).toContain("Unknown option: --unknown");

    const resBefore = runScript(["--unknown", "--dry-run"]);
    expect(resBefore.status).toBe(2);
    expect(resBefore.stderr).toContain("Unknown option: --unknown");
  });

  it("exits 1 when invoked with no arguments and CONFIRM_MAINNET is unset", () => {
    const res = runScript([], { CONFIRM_MAINNET: "" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("This sends real transactions on Stellar MAINNET");
  });
});
