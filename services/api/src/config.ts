/**
 * Env-var driven config for services/api. Kept in one place so the rest of the service reads
 * typed config instead of `process.env` directly (mirrors the pattern in
 * `@ballast/network-config`).
 */
export interface ApiConfig {
  port: number;
  sep10SigningKey: string;
  webhookHmacSecret: string;
  /**
   * Gap noted per task spec: subscriber URLs come from a static env-configured list rather than
   * a full subscription-management API (POST /v1/webhooks/subscriptions or similar). Follow-up.
   */
  webhookSubscribers: string[];
  /**
   * Institution API-key auth (PRD §9 "API key + HMAC for institutions"). Stubbed as an env var
   * map of `apiKey -> { partyId, stellarAccount, hmacSecret }` JSON-encoded, rather than reading
   * a `party` table column — see auth.ts for the tradeoff. Follow-up: move this into the `party`
   * table (e.g. a `party_api_key` table) once institution onboarding is a real flow.
   */
  institutionApiKeys: Record<string, { partyId: string; stellarAccount: string; hmacSecret: string }>;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  let institutionApiKeys: ApiConfig["institutionApiKeys"] = {};
  if (env.INSTITUTION_API_KEYS) {
    try {
      institutionApiKeys = JSON.parse(env.INSTITUTION_API_KEYS);
    } catch {
      throw new Error("services/api: INSTITUTION_API_KEYS is not valid JSON");
    }
  }

  return {
    port: env.API_PORT ? Number(env.API_PORT) : 3000,
    sep10SigningKey: env.SEP10_SIGNING_KEY ?? "",
    webhookHmacSecret: env.WEBHOOK_HMAC_SECRET ?? "",
    webhookSubscribers: (env.WEBHOOK_SUBSCRIBERS ?? "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    institutionApiKeys,
  };
}
