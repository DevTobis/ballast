/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Must match the API's configured `STELLAR_NETWORK_PASSPHRASE` — passed to Freighter's
   * `signTransaction` so the SEP-10 challenge is signed against the same network the API
   * verifies it against, regardless of which network the user's Freighter happens to be on. */
  readonly VITE_STELLAR_NETWORK_PASSPHRASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
