import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export interface StreamHandle {
  db: Database.Database;
  masterKey: Buffer;
  userDir: string;
  dbPath: string;
}

export interface OpenOptions {
  dbPath?: string;
}

export function openStreamDb(
  userDir: string,
  masterKey: Buffer,
  options: OpenOptions = {}
): StreamHandle {
  fs.mkdirSync(userDir, { recursive: true });
  const dbPath = options.dbPath ?? path.join(userDir, "stream.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return { db, masterKey, userDir, dbPath };
}

export function closeStreamDb(handle: StreamHandle): void {
  if (handle.db.open) {
    handle.db.close();
  }
}
