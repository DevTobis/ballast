import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadApiConfig, parseMarginThresholds } from "../config.js";

const VALID_SECRET = Keypair.random().secret();

const NETWORK_ENV = {
  STELLAR_RPC_URL: "http://localhost:8000/soroban/rpc",
  STELLAR_HORIZON_URL: "http://localhost:8000",
  STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017",
};

const PRODUCTION_REQUIRED_ENV = {
  ...NETWORK_ENV,
  NODE_ENV: "production",
  SEP10_SERVER_SECRET: VALID_SECRET,
  JWT_SIGNING_SECRET: "a-real-jwt-secret",
  WEBHOOK_SECRET_KEY: "ab".repeat(32),
  API_KEY_SECRET_KEY: "cd".repeat(32),
  CONSOLE_ORIGIN: "https://console.example.com",
};

describe("loadApiConfig", () => {
  it("succeeds in production when every required secret is set", () => {
    const config = loadApiConfig(PRODUCTION_REQUIRED_ENV);
    expect(config.sep10ServerSecret).toBe(PRODUCTION_REQUIRED_ENV.SEP10_SERVER_SECRET);
    expect(config.jwtSigningSecret).toBe(PRODUCTION_REQUIRED_ENV.JWT_SIGNING_SECRET);
    expect(config.webhookSecretKey).toBe(PRODUCTION_REQUIRED_ENV.WEBHOOK_SECRET_KEY);
    expect(config.apiKeySecretKey).toBe(PRODUCTION_REQUIRED_ENV.API_KEY_SECRET_KEY);
    expect(config.consoleOrigin).toBe(PRODUCTION_REQUIRED_ENV.CONSOLE_ORIGIN);
  });

  it("throws a clear error in production when a required secret is missing", () => {
    const { JWT_SIGNING_SECRET: _omit, ...envWithoutJwtSecret } = PRODUCTION_REQUIRED_ENV;
    expect(() => loadApiConfig(envWithoutJwtSecret)).toThrowError(/JWT_SIGNING_SECRET/);
  });

  it("throws listing every missing required secret at once, not just the first", () => {
    expect(() => loadApiConfig({ ...NETWORK_ENV, NODE_ENV: "production" })).toThrowError(
      /SEP10_SERVER_SECRET.*JWT_SIGNING_SECRET.*WEBHOOK_SECRET_KEY.*API_KEY_SECRET_KEY.*CONSOLE_ORIGIN/s,
    );
  });

  it("rejects an encryption key that is not 32 bytes of hex", () => {
    expect(() => loadApiConfig({ ...NETWORK_ENV, API_KEY_SECRET_KEY: "too-short" })).toThrowError(/API_KEY_SECRET_KEY/);
    expect(() => loadApiConfig({ ...NETWORK_ENV, WEBHOOK_SECRET_KEY: "zz".repeat(32) })).toThrowError(/WEBHOOK_SECRET_KEY/);
  });

  it("rejects a malformed SEP10_SERVER_SECRET naming the variable", () => {
    expect(() => loadApiConfig({ ...PRODUCTION_REQUIRED_ENV, SEP10_SERVER_SECRET: "not-a-stellar-seed" })).toThrowError(
      /SEP10_SERVER_SECRET/,
    );
  });

  it("stays permissive outside production even with every secret unset", () => {
    expect(() => loadApiConfig(NETWORK_ENV)).not.toThrow();
    const config = loadApiConfig(NETWORK_ENV);
    expect(config.sep10ServerSecret).toBe("");
    expect(config.jwtSigningSecret).toBe("");
  });

  it("reads a secret from NAME_FILE when the variable itself is not set, trimming the newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "ballast-secret-"));
    const file = join(dir, "jwt");
    writeFileSync(file, "secret-from-a-file\n");
    const { JWT_SIGNING_SECRET: _omit, ...rest } = PRODUCTION_REQUIRED_ENV;
    const config = loadApiConfig({ ...rest, JWT_SIGNING_SECRET_FILE: file });
    expect(config.jwtSigningSecret).toBe("secret-from-a-file");
  });

  it("prefers the variable over the file, and fails clearly on an unreadable file", () => {
    expect(loadApiConfig({ ...PRODUCTION_REQUIRED_ENV, JWT_SIGNING_SECRET_FILE: "/nonexistent" }).jwtSigningSecret).toBe(
      PRODUCTION_REQUIRED_ENV.JWT_SIGNING_SECRET,
    );
    const { JWT_SIGNING_SECRET: _omit, ...rest } = PRODUCTION_REQUIRED_ENV;
    expect(() => loadApiConfig({ ...rest, JWT_SIGNING_SECRET_FILE: "/nonexistent/secret" })).toThrowError(/JWT_SIGNING_SECRET_FILE/);
  });
});

import { parseComplianceEnforced, parseTrustProxy } from "../config.js";

describe("parseTrustProxy", () => {
  it("is off unless asked for, and understands true, a hop count and a list", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12")).toBe("10.0.0.0/8,172.16.0.0/12");
  });
});

describe("parseComplianceEnforced", () => {
  it("defaults to true in production and false in other environments when unset or empty", () => {
    expect(parseComplianceEnforced(undefined, "production")).toBe(true);
    expect(parseComplianceEnforced("", "production")).toBe(true);
    expect(parseComplianceEnforced(undefined, "development")).toBe(false);
    expect(parseComplianceEnforced("", "test")).toBe(false);
  });

  it("enables compliance on true, TRUE, and 1", () => {
    expect(parseComplianceEnforced("true", "development")).toBe(true);
    expect(parseComplianceEnforced("TRUE", "development")).toBe(true);
    expect(parseComplianceEnforced("1", "development")).toBe(true);
    expect(parseComplianceEnforced(" 1 ", "development")).toBe(true);
  });

  it("disables compliance on false, FALSE, and 0", () => {
    expect(parseComplianceEnforced("false", "production")).toBe(false);
    expect(parseComplianceEnforced("FALSE", "production")).toBe(false);
    expect(parseComplianceEnforced("0", "production")).toBe(false);
    expect(parseComplianceEnforced(" 0 ", "production")).toBe(false);
  });

  it("throws a clear error on unrecognized values", () => {
    expect(() => parseComplianceEnforced("yes", "production")).toThrowError(/invalid COMPLIANCE_ENFORCED/);
    expect(() => parseComplianceEnforced("ture", "production")).toThrowError(/invalid COMPLIANCE_ENFORCED/);
    expect(() => parseComplianceEnforced("foo", "development")).toThrowError(/invalid COMPLIANCE_ENFORCED/);
  });
});

describe("parseMarginThresholds", () => {
  it("returns default thresholds when unset", () => {
    expect(parseMarginThresholds({})).toEqual({
      warningBps: 7000,
      marginCallBps: 8000,
      liquidationBps: 9000,
    });
  });

  it("parses valid custom thresholds", () => {
    expect(
      parseMarginThresholds({
        API_MARGIN_WARNING_BPS: "6500",
        API_MARGIN_CALL_BPS: "7500",
        API_MARGIN_LIQUIDATION_BPS: "8500",
      }),
    ).toEqual({
      warningBps: 6500,
      marginCallBps: 7500,
      liquidationBps: 8500,
    });
  });

  it("throws validation error on bad ordering or out-of-range thresholds", () => {
    expect(() =>
      parseMarginThresholds({
        API_MARGIN_WARNING_BPS: "8000",
        API_MARGIN_CALL_BPS: "7000",
        API_MARGIN_LIQUIDATION_BPS: "9000",
      }),
    ).toThrowError(/margin thresholds/);

    expect(() =>
      parseMarginThresholds({
        API_MARGIN_WARNING_BPS: "7000",
        API_MARGIN_CALL_BPS: "9500",
        API_MARGIN_LIQUIDATION_BPS: "9000",
      }),
    ).toThrowError(/margin thresholds/);

    expect(() =>
      parseMarginThresholds({
        API_MARGIN_WARNING_BPS: "7000",
        API_MARGIN_CALL_BPS: "8000",
        API_MARGIN_LIQUIDATION_BPS: "10001",
      }),
    ).toThrowError(/margin thresholds/);
  });
});
