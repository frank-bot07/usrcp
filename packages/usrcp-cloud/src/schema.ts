/**
 * Postgres schema for the hosted ledger.
 *
 * CRITICAL: the server never sees plaintext. Every column that would leak
 * user data is stored as opaque ciphertext (the `enc:...` format emitted
 * by usrcp-local/src/encryption.ts). Only structural metadata — public
 * keys, timestamps, ledger sequence numbers, pseudonyms — is plaintext.
 *
 * This mirrors the local SQLite schema but adds `user_public_key` to
 * every table for row-level isolation and lets the server assign a
 * monotonic `ledger_sequence` per user.
 */

export const SCHEMA_SQL = `
-- Every user is identified by their Ed25519 public key (PEM). First write
-- with a new public key implicitly registers it. No accounts, no email.
CREATE TABLE IF NOT EXISTS users (
  public_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timeline events: append-only, server-assigned monotonic sequence.
-- Every encrypted column stores the local ledger's ciphertext verbatim.
CREATE TABLE IF NOT EXISTS timeline_events (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  client_timestamp TEXT NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  domain_pseudonym TEXT NOT NULL,
  platform_enc TEXT,
  summary_enc TEXT NOT NULL,
  intent_enc TEXT,
  outcome_enc TEXT,
  detail_enc TEXT,
  artifacts_enc TEXT,
  tags_enc TEXT,
  session_id_enc TEXT,
  parent_event_id_enc TEXT,
  idempotency_key TEXT,
  PRIMARY KEY (user_public_key, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_seq ON timeline_events(user_public_key, ledger_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_user_sequence
  ON timeline_events(user_public_key, ledger_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
  ON timeline_events(user_public_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- LWW metadata tables: one row per user, version bump on write.
CREATE TABLE IF NOT EXISTS core_identity (
  user_public_key TEXT PRIMARY KEY REFERENCES users(public_key) ON DELETE CASCADE,
  display_name_enc TEXT NOT NULL DEFAULT '',
  roles_enc TEXT NOT NULL DEFAULT '',
  expertise_domains_enc TEXT NOT NULL DEFAULT '',
  communication_style_enc TEXT NOT NULL DEFAULT '',
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS global_preferences (
  user_public_key TEXT PRIMARY KEY REFERENCES users(public_key) ON DELETE CASCADE,
  language_enc TEXT NOT NULL DEFAULT '',
  timezone_enc TEXT NOT NULL DEFAULT '',
  output_format_enc TEXT NOT NULL DEFAULT '',
  verbosity_enc TEXT NOT NULL DEFAULT '',
  custom_enc TEXT NOT NULL DEFAULT '',
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_context (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  domain_pseudonym TEXT NOT NULL,
  context_enc TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_public_key, domain_pseudonym)
);

CREATE TABLE IF NOT EXISTS active_projects (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  domain_enc TEXT NOT NULL,
  status_enc TEXT NOT NULL,
  summary_enc TEXT NOT NULL,
  last_touched TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_public_key, project_id)
);

CREATE TABLE IF NOT EXISTS schemaless_facts (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  fact_id TEXT NOT NULL,
  domain_pseudonym TEXT NOT NULL,
  ns_key_hash TEXT NOT NULL,
  namespace_enc TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_public_key, fact_id),
  UNIQUE (user_public_key, domain_pseudonym, ns_key_hash)
);

-- Encrypted domain pseudonym → name mapping, pushed by every device on sync.
-- The server stores only ciphertext (encrypted_name is opaque). Allows a
-- fresh device to receive domain_map rows before events so resolveDomain()
-- returns the real domain name immediately, enabling correct key derivation.
CREATE TABLE IF NOT EXISTS domain_maps (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  pseudonym TEXT NOT NULL,
  encrypted_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_public_key, pseudonym)
);
CREATE INDEX IF NOT EXISTS idx_domain_maps_user ON domain_maps(user_public_key);

-- Seen-nonces table: replay protection for signed requests. Prune
-- periodically; nothing here must outlive the signature time window.
CREATE TABLE IF NOT EXISTS seen_nonces (
  user_public_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_public_key, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonces_seen ON seen_nonces(seen_at);

-- Revoked public keys (identity rotation). When a user rotates from K1
-- to K2 via POST /v1/rotate-identity, the cloud (inside one transaction):
--   1. INSERTs a new K2 row in users, copying K1.created_at.
--   2. INSERT-SELECTs K1's stream_events into K2 (parent-first so the
--      composite FK on stream_embeddings stays valid), then
--      INSERT-SELECTs K1's stream_embeddings into K2.
--   3. UPDATEs every other per-user child table's user_public_key from
--      K1 to K2 (timeline_events, core_identity, global_preferences,
--      domain_context, active_projects, schemaless_facts, domain_maps).
--   4. DELETEs K1's stream_embeddings, stream_events, pairing_bundles,
--      seen_nonces, and finally the K1 users row.
--   5. INSERTs a row here with public_key=K1, rotated_to=K2.
-- The per-user FKs only declare ON DELETE CASCADE (no ON UPDATE
-- CASCADE), which is why rotation uses explicit UPDATEs / INSERT-SELECT
-- rather than a single UPDATE on users.public_key.
-- The auth middleware checks this table BEFORE the nonce claim and
-- RE-CHECKS it after the users upsert, so a revoked key cannot
-- recreate a fresh phantom user via the upsert-on-write path even
-- under the auth-upsert race window. Multiple rotations accumulate:
-- K1->K2->K3 yields rows (K1->K2), (K2->K3) with only K3 live in the
-- users table.
CREATE TABLE IF NOT EXISTS revoked_keys (
  public_key  TEXT PRIMARY KEY,
  rotated_to  TEXT,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revoked_rotated_to ON revoked_keys(rotated_to);

-- Multi-device pairing bundles (v2). Device A POSTs a client-encrypted
-- bundle under a short-TTL 8-digit code; device B GETs it by code and
-- decrypts locally with
-- HKDF-SHA256(IKM=secret, salt=code, info='usrcp-pairing-v2'), where
-- 'secret' is a 16-byte value that travels device-to-device out of
-- band (paste, AirDrop, QR) and NEVER reaches the cloud. The
-- decryption key requires the secret which the cloud has no path to;
-- brute-forcing the 128-bit secret is 2^128 work.
--
-- Threat-model precision (corrected after Codex Tier-2 #1):
--   * INTERNET attacker who has only the 8-digit code (guessed it,
--     observed it in transit, etc.) and hits /v1/pairing/claim sees
--     ONLY the ciphertext + expires_at + attempts_remaining. The
--     owner's public key is NOT in the response, so the attacker
--     cannot pivot "I know a code" -> "I know whose code it is."
--   * DB-DUMP attacker (operator with row-level read, leaked backup)
--     sees the code, the ciphertext, AND owner_public_key. The column
--     is retained because the server needs it to (a) enforce that the
--     same owner can replace their own pending bundle and (b) refuse
--     a re-init from a DIFFERENT identity for a colliding code, and
--     (c) prune on identity rotation. The 8-digit codespace + 10-min
--     TTL keeps the exposure window tight.
--
-- claim_attempts is incremented on every GET; once it hits 5, the
-- prune loop deletes the row (forces device A to re-init rather than
-- letting an external attacker who does NOT know the code keep
-- trying via the public claim endpoint). The v1 design (8-digit
-- code = scrypt input, cloud trusted for the TTL) is retired; see
-- tasks/12-pair-tier-2.md.
CREATE TABLE IF NOT EXISTS pairing_bundles (
  code             TEXT PRIMARY KEY,
  owner_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  encrypted_bundle TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  claim_attempts   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_bundles(expires_at);
CREATE INDEX IF NOT EXISTS idx_pairing_owner ON pairing_bundles(owner_public_key);

-- ============================================================================
-- usrcp-stream sync tables.
-- ============================================================================
-- The sibling usrcp-stream package writes conversational events into a
-- separate local SQLite DB (stream.db) under its own HKDF keyspace
-- (stream-events, stream-threads, stream-surface, stream-config, and
-- stream-embeddings for sync). The two tables below mirror that
-- structure on the server side so a user with multiple devices can
-- push stream events from device A and pull them on device B.
--
-- Threads and surface_state are NOT synced - threads are derived state
-- (the local stitcher re-runs on pull) and active-surface is
-- per-device by definition.
--
-- All encrypted columns store opaque ciphertext from the client; the
-- server never decrypts. surface / side / content_kind / ts_ms stay
-- plaintext for cursor/index purposes (same posture as the ledger's
-- domain_pseudonym and timestamps).

CREATE TABLE IF NOT EXISTS stream_events (
  user_public_key TEXT NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  server_seq BIGSERIAL NOT NULL,
  client_timestamp TEXT,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  surface TEXT NOT NULL,
  side TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  ts_ms BIGINT NOT NULL,
  channel_ref_enc TEXT NOT NULL,
  author_ref_enc TEXT NOT NULL,
  content_enc TEXT NOT NULL,
  entity_refs_enc TEXT,
  ingested_at BIGINT NOT NULL,
  schema_v INTEGER NOT NULL DEFAULT 1,
  embedding_present BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT,
  PRIMARY KEY (user_public_key, event_id),
  UNIQUE (user_public_key, server_seq)
);
CREATE INDEX IF NOT EXISTS idx_stream_events_user_seq
  ON stream_events(user_public_key, server_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_events_idempotency
  ON stream_events(user_public_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Per-event embedding row, attached 1:1 to a stream_events row via the
-- composite primary key. vec_enc is the client-side encrypted blob (raw
-- float32 bytes -> base64 -> AES-256-GCM via the stream-embeddings HKDF
-- domain). dims is plaintext so a fresh device can route the pulled
-- embedding into the matching event_vec_<dims> sqlite-vec table after
-- decryption.
CREATE TABLE IF NOT EXISTS stream_embeddings (
  user_public_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  vec_enc TEXT NOT NULL,
  dims INTEGER NOT NULL,
  model_enc TEXT,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (user_public_key, event_id),
  FOREIGN KEY (user_public_key, event_id)
    REFERENCES stream_events(user_public_key, event_id) ON DELETE CASCADE
);
`;
