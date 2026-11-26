import { describe, expect, it } from "vitest";
import { parseSession } from "../auth.tsx";

const valid = { token: "jwt", partyId: "party-1", stellarAccount: "GABC" };

describe("parseSession", () => {
  it("round-trips a valid session unchanged", () => {
    expect(parseSession(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([
    ["an empty object", "{}"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"abc"'],
    ["a number", "42"],
    ["malformed JSON", "{not json"],
    ["a missing field", JSON.stringify({ token: "jwt", partyId: "p" })],
    ["a non-string field", JSON.stringify({ ...valid, partyId: 7 })],
    ["an empty token", JSON.stringify({ ...valid, token: "" })],
  ])("discards %s", (_label, raw) => {
    expect(parseSession(raw)).toBeNull();
  });

  it("drops unknown extra fields", () => {
    expect(parseSession(JSON.stringify({ ...valid, role: "admin" }))).toEqual(valid);
  });
});
