import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalNavMessage, verifyNavSignature } from "./navSignature.js";

/**
 * Golden vectors shared with `build_nav_message_matches_golden_vectors` in
 * `contracts/price-guard/src/lib.rs`, which asserts the same bytes on-chain:
 *   ("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "SPIKO",   1700000000, 10234567)
 *     -> "ballast-nav-v1:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC:SPIKO:1700000000:10234567"
 *   ("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "CETES28", 4102444800, 170141183460469231731687303715884105727)
 *     -> "ballast-nav-v1:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC:CETES28:4102444800:170141183460469231731687303715884105727"
 * The second value is i128::MAX. If either side changes, change both in the same commit.
 */
const vectors: Array<{
  contractId: string;
  assetCode: string;
  ts: number;
  value: string;
  message: string;
}> = JSON.parse(
  readFileSync(new URL("./__fixtures__/nav-message-vectors.json", import.meta.url), "utf8"),
);

describe("canonicalNavMessage", () => {
  it("covers both golden vectors", () => {
    expect(vectors.map((v) => v.message)).toEqual([
      "ballast-nav-v1:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC:SPIKO:1700000000:10234567",
      "ballast-nav-v1:CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC:CETES28:4102444800:170141183460469231731687303715884105727",
    ]);
  });

  it.each(vectors)("builds $message", ({ contractId, assetCode, ts, value, message }) => {
    expect(canonicalNavMessage(assetCode, ts, BigInt(value), contractId)).toEqual(
      Buffer.from(message, "utf8"),
    );
  });

  it("rejects cross-asset and cross-deployment signature replay", () => {
    const kp = Keypair.random();
    const pubBase64 = Buffer.from(kp.rawPublicKey()).toString("base64");
    const contractA = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const contractB = "CCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const ts = 1_700_000_000;
    const value = 10_234_567n;

    const sigA = kp.sign(canonicalNavMessage("SPIKO", ts, value, contractA));
    expect(verifyNavSignature("SPIKO", ts, value, sigA, pubBase64, contractA)).toBe(true);
    expect(verifyNavSignature("CETES28", ts, value, sigA, pubBase64, contractA)).toBe(false);
    expect(verifyNavSignature("SPIKO", ts, value, sigA, pubBase64, contractB)).toBe(false);
  });
});
