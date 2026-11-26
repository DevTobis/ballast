import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalNavMessage, verifyNavSignature } from "./navSignature.js";

/**
 * Golden vectors shared with `build_nav_message_matches_golden_vectors` in
 * `contracts/price-guard/src/lib.rs`, which asserts the same bytes on-chain:
 *   ("SPIKO",   1700000000, 10234567)                                -> "SPIKO:1700000000:10234567"
 *   ("CETES28", 4102444800, 170141183460469231731687303715884105727) -> "CETES28:4102444800:170141183460469231731687303715884105727"
 * The second value is i128::MAX. If either side changes, change both in the same commit.
 */
const vectors: Array<{ assetCode: string; ts: number; value: string; message: string }> = JSON.parse(
  readFileSync(new URL("./__fixtures__/nav-message-vectors.json", import.meta.url), "utf8"),
);

describe("canonicalNavMessage", () => {
  it("covers both golden vectors", () => {
    expect(vectors.map((v) => v.message)).toEqual([
      "SPIKO:1700000000:10234567",
      "CETES28:4102444800:170141183460469231731687303715884105727",
    ]);
  });

  it.each(vectors)("builds $message", ({ assetCode, ts, value, message }) => {
    expect(canonicalNavMessage(assetCode, ts, BigInt(value))).toEqual(Buffer.from(message, "utf8"));
  });

  it("verifies golden vector signatures against test keypair", () => {
    const pubkeyBase64 = "/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=";
    const sig1 = Buffer.from(
      "234bd254088c736541fe363aa4d7163004ece797b6dfc6d58d3e796987cfc20501ae42a42e9db5d1a026294b755e3c98943fdce037cff1bacfd578e749a7ba0e",
      "hex",
    );
    expect(verifyNavSignature("SPIKO", 1700000000, 10234567n, sig1, pubkeyBase64)).toBe(true);

    const sig2 = Buffer.from(
      "8d3d74080eedf829ec37883108d114c7430729a98d904561c05f1c09280c5ace0632377afafe85061421bee92cc6de6bf6e4cacf2b82aef39d4a2333d8294c0c",
      "hex",
    );
    expect(
      verifyNavSignature(
        "CETES28",
        4102444800,
        170141183460469231731687303715884105727n,
        sig2,
        pubkeyBase64,
      ),
    ).toBe(true);
  });
});
