import { createAdapterConfig } from "usrcp-adapter-kit";

/**
 * Config for the Gmail adapter. Sensitive secrets
 * (`oauth_client_secret`, `refresh_token`) are encrypted at rest
 * under the USRCP global encryption key derived from the master
 * key; the file lives at mode 0600 either way. Legacy plaintext
 * configs (pre-#54) load transparently and are re-encrypted on the
 * next save.
 */
export interface GmailConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 600 = 10 min). */
  poll_interval_s: number;
  /**
   * ISO timestamp; queries use `after:` Gmail-query syntax with the
   * unix seconds form of this value. Gmail's search resolution is
   * 1 second, so the cursor advances in seconds.
   */
  last_synced_at?: string;
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. This file only
// declares Gmail's field shape (two OAuth secrets) and re-exports the
// store under the names Gmail's other modules already import.
const store = createAdapterConfig<GmailConfig>({
  adapterName: "gmail",
  filename: "gmail-config.json",
  fields: [
    { name: "oauth_client_id", kind: "required" },
    { name: "oauth_client_secret", kind: "secret" },
    { name: "refresh_token", kind: "secret" },
    { name: "domain", kind: "required" },
    { name: "poll_interval_s", kind: "requiredNumber" },
    { name: "last_synced_at", kind: "optional" },
  ],
  cursorFields: ["last_synced_at"],
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeGmailConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;

/** Debounced single-cursor write (`after:` >= last_synced_at). */
export const saveLastSyncedAt = (ts: string, masterKey: Buffer): void =>
  store.saveCursors({ last_synced_at: ts }, masterKey);
export const flushLastSyncedAt = store.flushCursors;
