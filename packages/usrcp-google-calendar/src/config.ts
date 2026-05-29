import { createAdapterConfig } from "usrcp-adapter-kit";

export interface GoogleCalendarConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  /** Long-lived OAuth refresh token. Used to mint short-lived access tokens on each poll. */
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 300 = 5 min). */
  poll_interval_s: number;
  /** ISO timestamp; queries use updatedMin >= last_synced_at. */
  last_synced_at?: string;
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. Declares
// Google Calendar's field shape (two OAuth secrets) and re-exports the
// store under the names its other modules already import.
const store = createAdapterConfig<GoogleCalendarConfig>({
  adapterName: "google-calendar",
  filename: "google-calendar-config.json",
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
export const writeGoogleCalendarConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;

/** Debounced single-cursor write (updatedMin >= last_synced_at). */
export const saveLastSyncedAt = (ts: string, masterKey: Buffer): void =>
  store.saveCursors({ last_synced_at: ts }, masterKey);
export const flushLastSyncedAt = store.flushCursors;
