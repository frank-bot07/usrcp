import { createAdapterConfig } from "usrcp-adapter-kit";

export interface LinearConfig {
  linear_api_key: string;
  /**
   * Linear API keys are workspace-scoped, so the allowlist gives multi-team
   * users fine-grained control over which work shows up in USRCP.
   */
  allowlisted_team_ids: string[];
  domain: string;
  poll_interval_s: number;
  /** ISO timestamp; queries use createdAt >= last_synced_at. */
  last_synced_at?: string;
}

// Encrypted-at-rest config store. All the crypto / atomic-write /
// validation / legacy-plaintext-migration / rotation / debounced-cursor
// machinery lives once in usrcp-adapter-kit; this file just declares
// linear's field shape and re-exports the store under the names linear's
// other modules already import.
const store = createAdapterConfig<LinearConfig>({
  adapterName: "linear",
  filename: "linear-config.json",
  fields: [
    { name: "linear_api_key", kind: "secret" },
    { name: "allowlisted_team_ids", kind: "requiredNonEmptyArray" },
    { name: "domain", kind: "required" },
    { name: "poll_interval_s", kind: "requiredNumber" },
    { name: "last_synced_at", kind: "optional" },
  ],
  cursorFields: ["last_synced_at"],
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeLinearConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;

/** Debounced single-cursor write (createdAt >= last_synced_at). */
export const saveLastSyncedAt = (ts: string, masterKey: Buffer): void =>
  store.saveCursors({ last_synced_at: ts }, masterKey);
export const flushLastSyncedAt = store.flushCursors;
