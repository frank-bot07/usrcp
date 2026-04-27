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
`;
