import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalNavMessage, verifyNavSignature } from "./navSignature.js";

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

  it("verifies golden vector signatures against test keypair", () => {
    // Seed [9u8; 32]; the same signatures are checked on-chain in
    // `build_nav_message_matches_golden_vectors` and listed in docs/nav-signing.md.
    const pubkeyBase64 = "/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=";
    const sigs = [
      "b825b28dbbc233291612d673a6241e3d437cf706ff8170574ee29ffb4698c2e52287348566bbff6f6f9acd0718f9a48ba2badef453eccae3216ad350855ebb09",
      "be2908255296c8b80747766cb744d698616596a34a83c0c41db25037b51faed72605e1879ec94c167104027a1af7484f827db3f4b069eead381cedebc8c4be0b",
    ];
    vectors.forEach(({ contract, assetCode, ts, value }, i) => {
      const sig = Buffer.from(sigs[i], "hex");
      expect(verifyNavSignature(contract, assetCode, ts, BigInt(value), sig, pubkeyBase64)).toBe(true);
    });
  });

  it("rejects a vector signature checked against another deployment or asset code", () => {
    const pubkeyBase64 = "/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=";
    const sig = Buffer.from(
      "b825b28dbbc233291612d673a6241e3d437cf706ff8170574ee29ffb4698c2e52287348566bbff6f6f9acd0718f9a48ba2badef453eccae3216ad350855ebb09",
      "hex",
    );
    const [v] = vectors;
    expect(verifyNavSignature(vectors[1].contract, v.assetCode, v.ts, BigInt(v.value), sig, pubkeyBase64)).toBe(false);
    expect(verifyNavSignature(v.contract, "CETES28", v.ts, BigInt(v.value), sig, pubkeyBase64)).toBe(false);
  });
});
