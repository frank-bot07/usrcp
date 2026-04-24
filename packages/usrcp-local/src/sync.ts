/**
 * Client-side sync with a hosted USRCP ledger.
 *
 * The local ledger is the source of truth for encryption; it hands the
 * cloud opaque ciphertexts. The cloud assigns its own monotonic
 * `ledger_sequence` per user — which differs from the local sequence.
 * We track a remote cursor separately from the local sequence.
 *
 * Phase 1: events push/pull only. Metadata (identity/prefs/context/facts)
 * sync is a Phase 2 concern (needs reconciliation rules per PROTOCOL §7).
 */

import * as crypto from "node:crypto";
import { Ledger } from "./ledger/index.js";
import { getIdentity, getDecryptedPrivateKeyPem } from "./crypto.js";
import { readConfig, updateConfig } from "./config.js";
import { initializeMasterKey, isPassphraseMode } from "./encryption.js";

export interface SyncStatus {
  cloud_endpoint: string | null;
  last_push_local_seq: number;
  last_pull_remote_cursor: number;
  last_sync_at: string | null;
  pending_events_to_push: number;
  local_max_seq: number;
}

export interface SyncPushResult {
  pushed: number;
  cursor: number;
}

export interface SyncPullResult {
  pulled: number;
  cursor: number;
  applied: number;
}

// KEEP IN SYNC WITH packages/usrcp-cloud/src/auth.ts (canonicalRequest, signRequest).
// The cloud server verifies with exactly this canonicalization; any change must
// land in both files in the same commit or signatures silently break.
function canonicalRequest(
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canon = [method.toUpperCase(), path, String(timestampMs), nonce, bodyHash].join("\n");
  return Buffer.from(canon, "utf8");
}

function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
  body: string,
  opts: { timestampMs?: number; nonce?: string } = {}
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = opts.timestampMs ?? Date.now();
  const nonce = opts.nonce ?? crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, path, timestampMs, nonce, body);
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, canon, key);
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}

async function signedFetch(
  endpoint: string,
  pathWithQuery: string,
  method: "GET" | "POST",
  body: unknown | undefined,
  publicKeyPem: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; json: any }> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signed = signRequest(privateKeyPem, method, pathWithQuery, bodyStr);
  const url = endpoint.replace(/\/$/, "") + pathWithQuery;
  const res = await fetchImpl(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
    body: method === "POST" ? bodyStr : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

export interface SyncOpts {
  passphrase?: string;
  fetchImpl?: typeof fetch;
  limit?: number;
}

/**
 * Push local events (ledger_sequence > last_push_local_seq) to the
 * hosted ledger. The cloud re-sequences them under its own per-user
 * counter; we persist last_push_local_seq on success.
 */
export async function syncPush(opts: SyncOpts = {}): Promise<SyncPushResult> {
  const cfg = readConfig();
  if (!cfg.cloud_endpoint) {
    throw new Error("No cloud_endpoint configured. Run: usrcp config set cloud_endpoint <url>");
  }
  const identity = getIdentity();
  if (!identity) throw new Error("Ledger not initialized");

  const masterKey = initializeMasterKey(opts.passphrase);
  const privateKeyPem = getDecryptedPrivateKeyPem(masterKey);
  const ledger = new Ledger(undefined, opts.passphrase);

  try {
    const lastPushed = cfg.last_push_local_seq ?? 0;
    const toPush = ledger.listEncryptedEventsAbove(lastPushed, opts.limit ?? 500);
    if (toPush.length === 0) {
      return { pushed: 0, cursor: lastPushed };
    }

    const wirePayload = {
      events: toPush.map((e) => ({
        event_id: e.event_id,
        client_timestamp: e.timestamp,
        domain_pseudonym: e.domain,
        platform_enc: e.platform,
        summary_enc: e.summary,
        intent_enc: e.intent,
        outcome_enc: e.outcome,
        detail_enc: e.detail,
        artifacts_enc: e.artifacts,
        tags_enc: e.tags,
        session_id_enc: e.session_id,
        parent_event_id_enc: e.parent_event_id,
        idempotency_key: e.idempotency_key ?? `local:${e.event_id}`,
      })),
    };

    const res = await signedFetch(
      cfg.cloud_endpoint,
      "/v1/events",
      "POST",
      wirePayload,
      identity.public_key,
      privateKeyPem,
      opts.fetchImpl
    );
    if (res.status !== 200) {
      throw new Error(`Push failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    }

    const newLocalSeq = Math.max(...toPush.map((e) => Number(e.ledger_sequence)));
    updateConfig({
      last_push_local_seq: newLocalSeq,
      last_sync_at: new Date().toISOString(),
    });
    return { pushed: toPush.length, cursor: newLocalSeq };
  } finally {
    ledger.close();
  }
}

/**
 * Pull events from the hosted ledger that the server assigned a
 * `ledger_sequence > last_pull_remote_cursor`. Inserts them into the
 * local ledger if absent, skipping duplicates by `event_id`.
 */
export async function syncPull(opts: SyncOpts = {}): Promise<SyncPullResult> {
  const cfg = readConfig();
  if (!cfg.cloud_endpoint) {
    throw new Error("No cloud_endpoint configured. Run: usrcp config set cloud_endpoint <url>");
  }
  const identity = getIdentity();
  if (!identity) throw new Error("Ledger not initialized");

  const masterKey = initializeMasterKey(opts.passphrase);
  const privateKeyPem = getDecryptedPrivateKeyPem(masterKey);
  const ledger = new Ledger(undefined, opts.passphrase);

  try {
    const lastPull = cfg.last_pull_remote_cursor ?? 0;
    const res = await signedFetch(
      cfg.cloud_endpoint,
      `/v1/state?since=${lastPull}&limit=${opts.limit ?? 500}`,
      "GET",
      undefined,
      identity.public_key,
      privateKeyPem,
      opts.fetchImpl
    );
    if (res.status !== 200) {
      throw new Error(`Pull failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    }
    const remoteEvents = (res.json?.events ?? []) as any[];
    const remoteCursor = Number(res.json?.cursor ?? lastPull);

    const applied = ledger.applyPulledEvents(remoteEvents);

    updateConfig({
      last_pull_remote_cursor: remoteCursor,
      last_sync_at: new Date().toISOString(),
    });
    return { pulled: remoteEvents.length, cursor: remoteCursor, applied };
  } finally {
    ledger.close();
  }
}

export function syncStatus(opts: { passphrase?: string } = {}): SyncStatus {
  const cfg = readConfig();
  const identity = getIdentity();
  if (!identity) {
    return {
      cloud_endpoint: cfg.cloud_endpoint ?? null,
      last_push_local_seq: cfg.last_push_local_seq ?? 0,
      last_pull_remote_cursor: cfg.last_pull_remote_cursor ?? 0,
      last_sync_at: cfg.last_sync_at ?? null,
      pending_events_to_push: 0,
      local_max_seq: 0,
    };
  }
  const passphraseRequired = isPassphraseMode();
  const ledger = new Ledger(undefined, passphraseRequired ? opts.passphrase : undefined);
  try {
    const maxSeq = ledger.getMaxSequence();
    const pushed = cfg.last_push_local_seq ?? 0;
    return {
      cloud_endpoint: cfg.cloud_endpoint ?? null,
      last_push_local_seq: pushed,
      last_pull_remote_cursor: cfg.last_pull_remote_cursor ?? 0,
      last_sync_at: cfg.last_sync_at ?? null,
      pending_events_to_push: Math.max(0, maxSeq - pushed),
      local_max_seq: maxSeq,
    };
  } finally {
    ledger.close();
  }
}
