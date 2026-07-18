// A minimal better-sqlite3-compatible facade over Node's built-in `node:sqlite`
// (`DatabaseSync`). It exists so the ledger's ~250 call sites keep working
// unchanged (`.prepare().get/all/run`, `.exec`, `.pragma`, `.transaction`,
// `.close`) while we drop the native `better-sqlite3` dependency — which made
// `npm install -g usrcp` crash on npm 12+ (the native build script is blocked).
// See strategy/refactors/NODE_SQLITE_MIGRATION.md.
//
// Scope of compatibility (measured against actual usage, not the full
// better-sqlite3 surface): positional `?` params only (no named binding),
// `.get/.all/.run/.exec/.pragma/.transaction/.close`, and the `{readonly}`
// constructor option. Not implemented (unused): `.pluck/.raw/.iterate/
// .safeIntegers/.function/.aggregate/.backup`.

import { DatabaseSync, type StatementSync } from "node:sqlite";

// On Node 22, `node:sqlite` emits a one-time ExperimentalWarning to stderr on
// first use ("SQLite is an experimental feature and might change at any time").
// It's stable and warning-free on Node 24+. Suppress ONLY that specific warning
// so the CLI output stays clean on Node 22 LTS; every other warning is
// untouched. (Narrow + idempotent — usrcp-core's only consumers are usrcp-*
// packages.)
const _origEmitWarning = process.emitWarning.bind(process);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = (warning: unknown, ...rest: unknown[]): void => {
  const msg =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : "";
  if (msg.includes("SQLite is an experimental feature")) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_origEmitWarning as any)(warning, ...rest);
};

export interface RunResult {
  // Row counts are small; node:sqlite returns a plain number for `changes`.
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement {
  constructor(private readonly stmt: StatementSync) {}
  get(...params: unknown[]): unknown {
    return this.stmt.get(...(params as never[]));
  }
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...(params as never[])) as unknown[];
  }
  run(...params: unknown[]): RunResult {
    return this.stmt.run(...(params as never[])) as unknown as RunResult;
  }
}

export interface DatabaseOptions {
  readonly?: boolean;
}

export class Database {
  /** @internal underlying node:sqlite handle */
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string, opts: DatabaseOptions = {}) {
    // better-sqlite3 opens read-write and creates the file if missing; node:sqlite
    // matches that with { open: true } (default). Only `readonly` is used here.
    this.db = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  // better-sqlite3's `.pragma(str)` runs `PRAGMA <str>` and returns result rows.
  // node:sqlite has no `.pragma()`; prepare+all covers both settings (returns []
  // or the applied value) and queries (integrity_check, wal_checkpoint, ...).
  pragma(pragma: string): unknown[] {
    return this.db.prepare("PRAGMA " + pragma).all() as unknown[];
  }

  // better-sqlite3-compatible transaction wrapper. Returns a function that runs
  // `fn` inside a transaction; nesting is supported via SAVEPOINTs (mirroring
  // better-sqlite3) so a transaction body may call another transaction-wrapped
  // method without "cannot start a transaction within a transaction".
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const top = this.txDepth === 0;
      const sp = `usrcp_sp_${this.txDepth}`;
      this.db.exec(top ? "BEGIN" : `SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        this.db.exec(top ? "COMMIT" : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.txDepth--;
        try {
          this.db.exec(top ? "ROLLBACK" : `ROLLBACK TO ${sp}`);
          if (!top) this.db.exec(`RELEASE ${sp}`);
        } catch {
          /* best-effort unwind */
        }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export default Database;
