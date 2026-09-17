import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../config.js";

const NETWORK_ENV = {
  STELLAR_RPC_URL: "http://localhost:8000/soroban/rpc",
  STELLAR_HORIZON_URL: "http://localhost:8000",
  STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017",
};

const PRODUCTION_REQUIRED_ENV = {
  ...NETWORK_ENV,
  NODE_ENV: "production",
  SEP10_SERVER_SECRET: "SBQWY3JPJKSAKQVQ7Q7TSPZCU5R5PGSWKZ35RQ7Q7TSPZCU5R5PGSWKZ",
  JWT_SIGNING_SECRET: "a-real-jwt-secret",
  WEBHOOK_HMAC_SECRET: "a-real-webhook-secret",
  CONSOLE_ORIGIN: "https://console.example.com",
};

describe("loadApiConfig", () => {
  it("succeeds in production when every required secret is set", () => {
    const config = loadApiConfig(PRODUCTION_REQUIRED_ENV);
    expect(config.sep10ServerSecret).toBe(PRODUCTION_REQUIRED_ENV.SEP10_SERVER_SECRET);
    expect(config.jwtSigningSecret).toBe(PRODUCTION_REQUIRED_ENV.JWT_SIGNING_SECRET);
    expect(config.webhookHmacSecret).toBe(PRODUCTION_REQUIRED_ENV.WEBHOOK_HMAC_SECRET);
    expect(config.consoleOrigin).toBe(PRODUCTION_REQUIRED_ENV.CONSOLE_ORIGIN);
  });

  it("throws a clear error in production when a required secret is missing", () => {
    const { JWT_SIGNING_SECRET: _omit, ...envWithoutJwtSecret } = PRODUCTION_REQUIRED_ENV;
    expect(() => loadApiConfig(envWithoutJwtSecret)).toThrowError(/JWT_SIGNING_SECRET/);
  });

  it("throws listing every missing required secret at once, not just the first", () => {
    expect(() => loadApiConfig({ ...NETWORK_ENV, NODE_ENV: "production" })).toThrowError(
      /SEP10_SERVER_SECRET.*JWT_SIGNING_SECRET.*WEBHOOK_HMAC_SECRET.*CONSOLE_ORIGIN/s,
    );
  });

  it("stays permissive outside production even with every secret unset", () => {
    expect(() => loadApiConfig(NETWORK_ENV)).not.toThrow();
    const config = loadApiConfig(NETWORK_ENV);
    expect(config.sep10ServerSecret).toBe("");
    expect(config.jwtSigningSecret).toBe("");
  });
});
