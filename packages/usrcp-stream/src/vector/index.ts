import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";

// Loads the platform-specific sqlite-vec extension into the given DB
// handle. Throws with a clear message if the native binding isn't
// available — surfacing the build/install issue at first use rather than
// silently degrading semantic recall.
export function loadVectorExtension(db: Database.Database): void {
  try {
    sqliteVec.load(db);
  } catch (err) {
    throw new Error(
      `Failed to load sqlite-vec extension: ${(err as Error).message}. ` +
        `Ensure the platform package (e.g. sqlite-vec-darwin-arm64) is installed.`
    );
  }
}

// vec0 virtual tables must be created with a fixed dim. We split by dims
// so a user who switches embedding models doesn't have to nuke the DB —
// new model = new vec_<dims> table, existing rows keep working.
export function ensureVectorTable(db: Database.Database, dims: number): string {
  const tableName = vectorTableName(dims);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      embedding float[${dims}]
    );
  `);
  return tableName;
}

export function vectorTableName(dims: number): string {
  return `event_vec_${dims}`;
}

export function insertVector(
  db: Database.Database,
  table: string,
  embeddingId: number,
  vec: Float32Array
): void {
  // sqlite-vec's vec0 rowid is a strict INTEGER. better-sqlite3 binds JS
  // numbers as INTEGER when safe-integer, but vec0 still rejects them in
  // some build configs; BigInt forces SQLITE_INTEGER unconditionally.
  db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`).run(
    BigInt(embeddingId),
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
  );
}
