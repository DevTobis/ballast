/**
 * Env-var driven config for services/api. Kept in one place so the rest of the service reads
 * typed config instead of `process.env` directly (mirrors the pattern in
 * `@ballast/network-config`).
 */
import { readFileSync } from "node:fs";
import { loadNetworkConfig } from "@ballast/network-config";

export interface ApiConfig {
  port: number;
  /** HMAC secret used to sign/verify the app's own session JWTs (`{ sub: G-address }`). Not a
   * SEP-10 signing key — SEP-10 challenge transactions are signed by `sep10ServerSecret`, a real
   * Stellar keypair, per `routes/auth.ts`. */
  jwtSigningSecret: string;
  /** Real Stellar keypair secret (`S...`) the SEP-10 challenge transactions are built/signed
   * with. Distinct from `jwtSigningSecret` on purpose — one authenticates Stellar accounts via
   * SEP-10, the other signs this app's own session tokens. */
  sep10ServerSecret: string;
  /** Fully qualified domain name of the service requiring authentication (SEP-10 `home_domain`). */
  sep10HomeDomain: string;
  /** Fully qualified domain name of the service issuing the challenge (SEP-10 `web_auth_domain`). */
  sep10WebAuthDomain: string;
  /** Stellar network passphrase, needed to build/verify SEP-10 challenge transactions. Sourced
   * through `@ballast/network-config` so it stays in sync with the rest of the service's Stellar
   * config instead of being a second, independently-configured copy. */
  networkPassphrase: string;
  /** 32-byte key (64 hex chars) that encrypts webhook signing secrets at rest. Webhook
   * subscriptions are refused (503) while it is unset. */
  webhookSecretKey: string;
  /** 32-byte key (64 hex chars) that encrypts institution API-key signing secrets at rest. API
   * keys cannot be created or used while it is unset. */
  apiKeySecretKey: string;
  /** Whether the KYB and sanctions gate runs in front of risk-taking routes. On by default in
   * production; off elsewhere so local runs and tests need no network. */
  complianceEnforced: boolean;
  /** Whether to believe `X-Forwarded-For` for the client address, and how many proxies to trust.
   * `false` (default) ignores the header. Behind a reverse proxy (Render, Caddy, a load balancer)
   * every request otherwise appears to come from the proxy, so the per-address rate limit and the
   * failed-login lockout would be shared by all users. Set it only when a proxy you control sits in
   * front: with no proxy, trusting the header lets any client pick its own address. */
  trustProxy?: boolean | number | string;
  /** Origin allowed to call this API from a browser (the console app). Passed straight to
   * `@fastify/cors`'s `origin` option — never `*`. */
  consoleOrigin: string;
}

/**
 * Secrets that must be real, non-empty values before this service is safe to run in production.
 * Left unset, they're fine in dev/test (`buildServer()`'s injectable `config` option already lets
 * tests bypass this function entirely) but would otherwise let the service boot with a blank JWT
 * secret, a blank SEP-10 signing key, a blank webhook secret key, or a wide-open CORS origin.
 * Mirrors the `REQUIRED` + `.filter` + one combined thrown-error-message pattern in
 * `packages/network-config/src/index.ts`.
 */
const PRODUCTION_REQUIRED = [
  "SEP10_SERVER_SECRET",
  "JWT_SIGNING_SECRET",
  "WEBHOOK_SECRET_KEY",
  "API_KEY_SECRET_KEY",
  "CONSOLE_ORIGIN",
] as const;

/**
 * Resolves a secret from `NAME`, or from the file named by `NAME_FILE` (the convention Docker and
 * Kubernetes secrets use), so a secret never has to sit in the process environment where a crash
 * dump or `docker inspect` would show it. The environment value wins if both are set.
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch (err) {
    throw new Error(`services/api: cannot read ${name}_FILE (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `TRUST_PROXY`: `true`, a hop count (`1`), or a comma-separated list of proxy addresses/CIDRs. */
export function parseComplianceEnforced(value: string | undefined, nodeEnv: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") {
    return nodeEnv === "production";
  }
  if (v === "true" || v === "1") {
    return true;
  }
  if (v === "false" || v === "0") {
    if (nodeEnv === "production") {
      console.warn("services/api: COMPLIANCE_ENFORCED is explicitly disabled in production; compliance gate is inactive");
    }
    return false;
  }
  throw new Error(
    `services/api: invalid COMPLIANCE_ENFORCED value '${value}'. Expected boolean (true/false, 1/0) or leave unset for environment default`,
  );
}

export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? "").trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function loadApiConfig(rawEnv: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Secrets may come from NAME_FILE; resolve them once and let the rest of this function read `env`.
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const name of ["SEP10_SERVER_SECRET", "JWT_SIGNING_SECRET", "WEBHOOK_SECRET_KEY", "API_KEY_SECRET_KEY"]) {
    const value = readSecret(name, rawEnv);
    if (value) env[name] = value;
  }

  if (env.NODE_ENV === "production") {
    const missing = PRODUCTION_REQUIRED.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(`services/api: missing required env vars in production: ${missing.join(", ")}`);
    }
  }

  for (const name of ["WEBHOOK_SECRET_KEY", "API_KEY_SECRET_KEY"] as const) {
    if (env[name] && !/^[0-9a-fA-F]{64}$/.test(env[name]!)) {
      throw new Error(`services/api: ${name} must be 32 bytes as 64 hex characters`);
    }
  }

  return {
    port: env.API_PORT ? Number(env.API_PORT) : 3000,
    jwtSigningSecret: env.JWT_SIGNING_SECRET ?? "",
    sep10ServerSecret: env.SEP10_SERVER_SECRET ?? "",
    sep10HomeDomain: env.SEP10_HOME_DOMAIN ?? "localhost",
    sep10WebAuthDomain: env.SEP10_WEB_AUTH_DOMAIN ?? env.SEP10_HOME_DOMAIN ?? "localhost",
    networkPassphrase: loadNetworkConfig(env).networkPassphrase,
    webhookSecretKey: env.WEBHOOK_SECRET_KEY ?? "",
    apiKeySecretKey: env.API_KEY_SECRET_KEY ?? "",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    complianceEnforced: parseComplianceEnforced(env.COMPLIANCE_ENFORCED, env.NODE_ENV),
    consoleOrigin: env.CONSOLE_ORIGIN ?? "http://localhost:5173",
  };
}
