/**
 * Thin pg pool wrapper. Exists so tests can inject pg-mem's adapter
 * without monkey-patching the real pg module.
 */

import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";

// Every column that stores a user identity. After #176 these hold the
// canonical SPKI-DER id (see auth.ts canonicalKeyId); older builds stored the
// raw PEM string. An in-place upgrade must not silently mix the two: a legacy
// revoked-key PEM row would stop matching the canonical id, so every revoked
// key would become usable again, and every active user would authenticate into
// a fresh empty canonical tenant while their data stayed under the raw PEM.
const IDENTITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["users", "public_key"],
  ["revoked_keys", "public_key"],
  ["revoked_keys", "rotated_to"],
  ["seen_nonces", "user_public_key"],
  ["pairing_bundles", "owner_public_key"],
  ["timeline_events", "user_public_key"],
  ["core_identity", "user_public_key"],
  ["global_preferences", "user_public_key"],
  ["domain_context", "user_public_key"],
  ["active_projects", "user_public_key"],
  ["schemaless_facts", "user_public_key"],
  ["domain_maps", "user_public_key"],
  ["stream_events", "user_public_key"],
  ["stream_embeddings", "user_public_key"],
];

/**
 * Thrown by migrate() when the database still holds raw-PEM identities from a
 * pre-#176 build. usrcp-cloud is pre-launch and its databases are disposable,
 * so we refuse to serve rather than attempt an in-place PEM->canonical rewrite:
 * proceeding would un-revoke revoked keys and strand existing tenants.
 */
export class LegacyPemIdentityError extends Error {
  constructor(offendingColumns: string[]) {
    super(
      "usrcp-cloud keys identities by their canonical SPKI-DER id (#176), but " +
        "this database still contains legacy PEM-encoded identity rows in: " +
        offendingColumns.join(", ") +
        ". In-place upgrade from PEM identities is not supported: serving " +
        "traffic would un-revoke previously revoked keys and strand existing " +
        "tenants under their old identity. Reset the database (drop and " +
        "recreate) before starting this build."
    );
    this.name = "LegacyPemIdentityError";
  }
}

export interface QueryClient {
  query<T = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface PoolClientLike extends QueryClient {
  release(err?: boolean | Error): void;
}

export interface PoolLike extends QueryClient {
  connect(): Promise<PoolClientLike>;
}

export class Db {
  constructor(private pool: PoolLike) {}

  async query<T = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }> {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    await assertNoLegacyPemIdentities(this.pool);
  }

  async close(): Promise<void> {
    if (this.pool instanceof Pool) {
      await (this.pool as Pool).end();
    }
  }
}

/**
 * Pre-traffic guard: reject a database still keyed by raw-PEM identities from a
 * pre-#176 build. Read-only and idempotent, so a canonical database and a
 * repeated call both pass. A canonical SPKI-DER id never contains the PEM
 * armor, so the marker match is exact. Called by Db.migrate() after the schema
 * is ensured; exported so the upgrade regression can exercise it directly
 * (pg-mem cannot re-run the full CREATE-table schema batch).
 */
export async function assertNoLegacyPemIdentities(q: QueryClient): Promise<void> {
  const offending: string[] = [];
  for (const [table, column] of IDENTITY_COLUMNS) {
    // table/column come from the fixed IDENTITY_COLUMNS constant, not input.
    // DISTINCT bounds the scan to the set of distinct identities (not row
    // count), and the PEM check runs in JS so it behaves identically on real
    // Postgres and the pg-mem test adapter, whose LIKE does not match against
    // multiline text values.
    const res = await q.query<{ v: string | null }>(
      `SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`
    );
    if (res.rows.some((r) => typeof r.v === "string" && r.v.includes("BEGIN PUBLIC KEY"))) {
      offending.push(`${table}.${column}`);
    }
  }
  if (offending.length > 0) {
    throw new LegacyPemIdentityError(offending);
  }
}

export function createPgPool(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return new Db(pool as unknown as PoolLike);
}
