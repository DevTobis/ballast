import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalNavMessage } from "./navSignature.js";

/**
 * Golden vectors shared with `build_nav_message_matches_golden_vectors` in
 * `contracts/price-guard/src/lib.rs`, which asserts the same bytes on-chain:
 *   ("CA66MNFKUT2SJDXOCZFTUNW6OGE5T5IVGUNZL53QR5PSMFWB4VJIZ4CC", "SPIKO",   1700000000, 10234567)                                -> "ballast-nav-v1:CA66MNFKUT2SJDXOCZFTUNW6OGE5T5IVGUNZL53QR5PSMFWB4VJIZ4CC:SPIKO:1700000000:10234567"
 *   ("CD4TZ6XYKNTBLXJP23XSZFMDMDYEG6WNOCCFM3A757YM6IGLXEQBF2RY", "CETES28", 4102444800, 170141183460469231731687303715884105727) -> "ballast-nav-v1:CD4TZ6XYKNTBLXJP23XSZFMDMDYEG6WNOCCFM3A757YM6IGLXEQBF2RY:CETES28:4102444800:170141183460469231731687303715884105727"
 * The second value is i128::MAX. If either side changes, change both in the same commit.
 */
const vectors: Array<{ contract: string; assetCode: string; ts: number; value: string; message: string }> = JSON.parse(
  readFileSync(new URL("./__fixtures__/nav-message-vectors.json", import.meta.url), "utf8"),
);

describe("canonicalNavMessage", () => {
  it("covers both golden vectors", () => {
    expect(vectors.map((v) => v.message)).toEqual([
      "ballast-nav-v1:CA66MNFKUT2SJDXOCZFTUNW6OGE5T5IVGUNZL53QR5PSMFWB4VJIZ4CC:SPIKO:1700000000:10234567",
      "ballast-nav-v1:CD4TZ6XYKNTBLXJP23XSZFMDMDYEG6WNOCCFM3A757YM6IGLXEQBF2RY:CETES28:4102444800:170141183460469231731687303715884105727",
    ]);
  });

  it.each(vectors)("builds $message", ({ contract, assetCode, ts, value, message }) => {
    expect(canonicalNavMessage(contract, assetCode, ts, BigInt(value))).toEqual(Buffer.from(message, "utf8"));
  });
});
