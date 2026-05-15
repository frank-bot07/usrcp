// Schema for stream.db. Inlined here rather than a sibling .sql file so the
// build pipeline (tsc-only, matching usrcp-local) stays one step. Encrypted
// columns are TEXT (the encryption helper returns "enc:<base64>" strings,
// not raw bytes). The per-event embedding vector (events.embedding_id ->
// embeddings.vec) stays raw float32 BLOB because sqlite-vec operates on
// the column index directly and re-encrypting per cosine lookup defeats
// the index. Thread centroids however are NOT indexed by sqlite-vec and
// only read by the stitcher, so they are encrypted on disk (Codex P1-2).
// recent_channels is encrypted JSON of the canonical channel keys this
// thread's events have ridden, used for same-channel continuation
// candidacy (Codex P1-1).

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid    TEXT UNIQUE NOT NULL,
  surface       TEXT NOT NULL,
  channel_ref   TEXT NOT NULL,
  side          TEXT NOT NULL,
  author_ref    TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_kind  TEXT NOT NULL,
  ts_ms         INTEGER NOT NULL,
  thread_id     TEXT,
  entity_refs   TEXT,
  embedding_id  INTEGER,
  ingested_at   INTEGER NOT NULL,
  schema_v      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_events_surface_ts ON events(surface, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms DESC);

CREATE TABLE IF NOT EXISTS threads (
  thread_id        TEXT PRIMARY KEY,
  first_ts_ms      INTEGER NOT NULL,
  last_ts_ms       INTEGER NOT NULL,
  surfaces         TEXT NOT NULL,
  entity_refs      TEXT,
  topic_centroid   TEXT,
  topic_dims       INTEGER,
  member_count     INTEGER NOT NULL DEFAULT 0,
  recent_channels  TEXT,
  summary          TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_last_ts ON threads(last_ts_ms DESC);

CREATE TABLE IF NOT EXISTS surface_state (
  surface       TEXT PRIMARY KEY,
  channel_ref   TEXT NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  heartbeat_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vec           BLOB NOT NULL,
  dims          INTEGER NOT NULL,
  model         TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('schema_v', '1');
`;
