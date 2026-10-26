import { describe, expect, it } from "vitest";
import { validateConfig } from "../config.ts";
import { marginBand } from "../format.ts";

const TESTNET = "Test SDF Network ; September 2015";

function problems(result: ReturnType<typeof validateConfig>) {
  return result.ok ? [] : result.problems.map((p) => p.variable);
}

describe("validateConfig", () => {
  it("accepts a complete production configuration", () => {
    const result = validateConfig({ VITE_API_URL: "https://api.example.com", VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true);
    expect(result).toEqual({ ok: true, config: { apiUrl: "https://api.example.com", networkPassphrase: TESTNET } });
  });

  it("strips trailing slashes from the API address", () => {
    const result = validateConfig({ VITE_API_URL: "https://api.example.com///", VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true);
    expect(result.ok && result.config.apiUrl).toBe("https://api.example.com");
  });

  it("keeps a path prefix on the API address", () => {
    const result = validateConfig({ VITE_API_URL: "https://example.com/api/", VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true);
    expect(result.ok && result.config.apiUrl).toBe("https://example.com/api");
  });

  it("falls back to localhost in development only", () => {
    const dev = validateConfig({ VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, false);
    expect(dev.ok && dev.config.apiUrl).toBe("http://localhost:3000");

    expect(problems(validateConfig({ VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true))).toEqual(["VITE_API_URL"]);
    expect(problems(validateConfig({ VITE_API_URL: "", VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true))).toEqual(["VITE_API_URL"]);
  });

  it("refuses a production build that points at this machine", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000"]) {
      expect(problems(validateConfig({ VITE_API_URL: url, VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, true))).toEqual(["VITE_API_URL"]);
    }
    expect(validateConfig({ VITE_API_URL: "http://localhost:3100", VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, false).ok).toBe(true);
  });

  it("rejects an API address that is not an http(s) URL", () => {
    for (const url of ["api.example.com", "ftp://api.example.com", "not a url"]) {
      expect(problems(validateConfig({ VITE_API_URL: url, VITE_STELLAR_NETWORK_PASSPHRASE: TESTNET }, false))).toEqual(["VITE_API_URL"]);
    }
  });

  it("requires the network passphrase in every mode", () => {
    for (const production of [true, false]) {
      expect(problems(validateConfig({ VITE_API_URL: "https://api.example.com" }, production))).toEqual(["VITE_STELLAR_NETWORK_PASSPHRASE"]);
      expect(
        problems(validateConfig({ VITE_API_URL: "https://api.example.com", VITE_STELLAR_NETWORK_PASSPHRASE: "  " }, production)),
      ).toEqual(["VITE_STELLAR_NETWORK_PASSPHRASE"]);
    }
  });

  it("rejects a passphrase with stray whitespace, since it is hashed into every signature", () => {
    const result = validateConfig({ VITE_API_URL: "https://api.example.com", VITE_STELLAR_NETWORK_PASSPHRASE: `${TESTNET} ` }, true);
    expect(problems(result)).toEqual(["VITE_STELLAR_NETWORK_PASSPHRASE"]);
  });

  it("accepts a custom passphrase", () => {
    const result = validateConfig({ VITE_API_URL: "https://api.example.com", VITE_STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017" }, true);
    expect(result.ok).toBe(true);
  });

  it("reports every problem at once", () => {
    expect(problems(validateConfig({}, true))).toEqual(["VITE_API_URL", "VITE_STELLAR_NETWORK_PASSPHRASE"]);
  });
});

describe("marginBand", () => {
  it("labels the band at each default threshold", () => {
    expect(marginBand(0)).toBe("healthy");
    expect(marginBand(6_999)).toBe("healthy");
    expect(marginBand(7_000)).toBe("warning");
    expect(marginBand(7_500)).toBe("warning");
    expect(marginBand(8_000)).toBe("margin call");
    expect(marginBand(9_000)).toBe("liquidation");
    expect(marginBand(15_000)).toBe("liquidation");
  });
});
