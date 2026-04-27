/**
 * Thin pg pool wrapper. Exists so tests can inject pg-mem's adapter
 * without monkey-patching the real pg module.
 */

import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";

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
  }

  async close(): Promise<void> {
    if (this.pool instanceof Pool) {
      await (this.pool as Pool).end();
    }
  }
}

export function createPgPool(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return new Db(pool as unknown as PoolLike);
}
