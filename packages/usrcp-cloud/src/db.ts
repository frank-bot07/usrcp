/**
 * Thin pg pool wrapper. Exists so tests can inject pg-mem's adapter
 * without monkey-patching the real pg module.
 */

import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";

export interface QueryClient {
  query<T = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class Db {
  constructor(private pool: QueryClient) {}

  async query<T = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }> {
    return this.pool.query<T>(text, values);
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
  return new Db(pool);
}
