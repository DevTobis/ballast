/**
 * The console's build-time configuration, read from the Vite environment in one place. Nothing else
 * reads `import.meta.env`, so a missing or malformed value is caught once at startup (see main.tsx)
 * and named on an error page, instead of surfacing later as "Failed to fetch" or a signature that
 * does not verify.
 */

/** Where the API is assumed to be during development when VITE_API_URL is unset. */
const DEV_API_URL = "http://localhost:3000";

export interface ConfigEnv {
  VITE_API_URL?: string;
  VITE_STELLAR_NETWORK_PASSPHRASE?: string;
}

export interface ConfigProblem {
  variable: keyof ConfigEnv;
  message: string;
}

export interface ConsoleConfig {
  apiUrl: string;
  networkPassphrase: string;
}

export type ConfigResult = { ok: true; config: ConsoleConfig } | { ok: false; problems: ConfigProblem[] };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

function validateApiUrl(raw: string | undefined, production: boolean): { value?: string; problem?: ConfigProblem } {
  const variable = "VITE_API_URL";
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") {
    if (production) {
      return { problem: { variable, message: "is not set. A production build has no default API address; set it at build time." } };
    }
    return { value: DEV_API_URL };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { problem: { variable, message: `"${trimmed}" is not a valid URL. Expected something like https://api.example.com.` } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { problem: { variable, message: `"${trimmed}" must start with http:// or https://.` } };
  }
  if (production && LOCAL_HOSTS.has(url.hostname)) {
    return { problem: { variable, message: `"${trimmed}" points at this machine. A production build must name the real API address.` } };
  }
  // Requests are built as `${apiUrl}${path}` with a leading slash on the path.
  return { value: trimmed.replace(/\/+$/, "") };
}

function validatePassphrase(raw: string | undefined): { value?: string; problem?: ConfigProblem } {
  const variable = "VITE_STELLAR_NETWORK_PASSPHRASE";
  if (raw === undefined || raw.trim() === "") {
    return {
      problem: {
        variable,
        message:
          'is not set. It must equal the API\'s STELLAR_NETWORK_PASSPHRASE, for example "Test SDF Network ; September 2015" for testnet.',
      },
    };
  }
  // The passphrase is hashed into every signature, so stray whitespace from a copy-paste would make
  // each one fail verification.
  if (raw !== raw.trim()) {
    return { problem: { variable, message: "has leading or trailing whitespace. Remove it; the passphrase must match the API's exactly." } };
  }
  return { value: raw };
}

/** Checks the build-time environment. `production` is `import.meta.env.PROD` for the running build. */
export function validateConfig(env: ConfigEnv, production: boolean): ConfigResult {
  const api = validateApiUrl(env.VITE_API_URL, production);
  const passphrase = validatePassphrase(env.VITE_STELLAR_NETWORK_PASSPHRASE);
  const problems = [api.problem, passphrase.problem].filter((p): p is ConfigProblem => p !== undefined);
  if (problems.length > 0 || api.value === undefined || passphrase.value === undefined) {
    return { ok: false, problems };
  }
  return { ok: true, config: { apiUrl: api.value, networkPassphrase: passphrase.value } };
}

/** The environment of the running build. */
export function readConfig(): ConfigResult {
  return validateConfig(import.meta.env, import.meta.env.PROD);
}

/**
 * The API address for requests. Read on each call and tolerant of an invalid environment (the
 * startup check is what reports that), so code paths and tests that never went through main.tsx
 * still work.
 */
export function apiUrl(): string {
  const result = validateApiUrl(import.meta.env.VITE_API_URL, false);
  return result.value ?? DEV_API_URL;
}

/** The network passphrase to sign for, or undefined when none is configured. */
export function networkPassphrase(): string | undefined {
  const value = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE;
  // An empty string (an unset Docker build arg) must reach Freighter as "not provided".
  return value ? value : undefined;
}
