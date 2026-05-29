import { createAdapterConfig } from "usrcp-adapter-kit";

export interface ImessageConfig {
  anthropic_api_key: string;
  /** User's own iMessage handle — phone (e.g. +14155551234) or email. */
  user_handle: string;
  /** Chat ROWIDs (as strings) from chat.db — stable per install. */
  allowlisted_chats: string[];
  /** Trigger prefix for group chats. Default: "..u " */
  prefix: string;
  /** Resume cursor for `imsg watch --since-rowid`. Updated per-event. */
  last_rowid?: number;
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. iMessage is the
// cursor outlier: its `last_rowid` is a NUMBER advanced per-event in the
// hot path with no master key available, so it keeps a bespoke
// verbatim-merge flush below (writeRaw, no decrypt/re-encrypt) rather
// than the kit's decrypt-re-encrypt saveCursors path. Everything else —
// crypto, validation, load, rotation — comes from the shared store.
//
// `migrateLegacyOnLoad: false` preserves iMessage's historical behavior:
// loadConfig passes a plaintext secret through unchanged and lets the
// next explicit writeImessageConfig encrypt it, rather than re-writing on
// load.
const store = createAdapterConfig<ImessageConfig>({
  adapterName: "imessage",
  filename: "imessage-config.json",
  fields: [
    { name: "anthropic_api_key", kind: "secret" },
    { name: "user_handle", kind: "required" },
    { name: "allowlisted_chats", kind: "requiredNonEmptyArray" },
    { name: "prefix", kind: "required" },
    { name: "last_rowid", kind: "optional" },
  ],
  migrateLegacyOnLoad: false,
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeImessageConfig = store.writeConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;

// ---------------------------------------------------------------------------
// Debounced last_rowid persistence (bespoke — see note above).
//
// saveLastRowid() is called per-event in the hot path. We coalesce writes
// via a 500ms debounce timer so disk I/O doesn't track every message. On
// SIGINT the caller flushes explicitly (flushLastRowid()).
//
// The flush merges the new rowid into the EXISTING on-disk config and
// writes it back AS-IS via writeRaw. The encrypted `anthropic_api_key`
// envelope is preserved verbatim — we never decrypt + re-encrypt in the
// hot path (which would also need the masterKey, breaking the
// cursor-write contract that today is fire-and-forget).
// ---------------------------------------------------------------------------

let _pendingRowid: number | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesced in-memory update; flushes to disk after 500ms of quiet. */
export function saveLastRowid(rowid: number): void {
  _pendingRowid = rowid;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushLastRowid();
  }, 500);
}

/** Immediately flush any pending rowid to disk. Call on SIGINT/SIGTERM. */
export function flushLastRowid(): void {
  if (_pendingRowid === undefined) return;
  const existing = readPartialConfig();
  // Pass-through merge: keep existing fields (including the encrypted
  // anthropic_api_key envelope) verbatim, just update last_rowid.
  const merged: ImessageConfig = {
    anthropic_api_key: existing.anthropic_api_key ?? "",
    user_handle: existing.user_handle ?? "",
    allowlisted_chats: existing.allowlisted_chats ?? [],
    prefix: existing.prefix ?? "..u ",
    ...existing,
    last_rowid: _pendingRowid,
  };
  try {
    store.writeRaw(merged as unknown as Record<string, unknown>);
  } catch {
    // Non-fatal — next restart may re-process a few events
  }
  _pendingRowid = undefined;
}
