import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import {
  encryptForColumn,
  decryptFromColumn,
  encryptJsonForColumn,
  decryptJsonFromColumn,
} from "../db/encrypted-row.js";

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-rows-"));
  // 32-byte deterministic-but-random key. Real callers pass Ledger.getMasterKey().
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("encrypted-row roundtrip", () => {
  it("writes encrypted ciphertext to disk and decrypts back to plaintext", () => {
    const plaintext = "user message: how do I exit vim";
    const ciphertext = encryptForColumn(masterKey, "events", plaintext);

    expect(ciphertext.startsWith("enc:")).toBe(true);
    expect(ciphertext).not.toContain("how do I exit vim");

    handle.db
      .prepare(
        `INSERT INTO events
         (event_uuid, surface, channel_ref, side, author_ref, content, content_kind, ts_ms, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "evt-1",
        "discord",
        encryptForColumn(masterKey, "events", JSON.stringify({ guild: "g1", channel: "c1" })),
        "inbound",
        encryptForColumn(masterKey, "events", JSON.stringify({ id: "u1", displayName: "frank" })),
        ciphertext,
        "text",
        Date.now(),
        Date.now()
      );

    // Read the raw row via a second Database handle to bypass any in-process
    // caching. The on-disk row's content column must be ciphertext.
    closeStreamDb(handle);
    const raw = new Database(handle.dbPath, { readonly: true });
    const row = raw.prepare("SELECT content, channel_ref, author_ref FROM events WHERE event_uuid = ?")
      .get("evt-1") as { content: string; channel_ref: string; author_ref: string };
    raw.close();

    expect(row.content.startsWith("enc:")).toBe(true);
    expect(row.content).not.toContain("how do I exit vim");
    expect(row.channel_ref.startsWith("enc:")).toBe(true);
    expect(row.author_ref.startsWith("enc:")).toBe(true);

    // Decrypt round-trip.
    expect(decryptFromColumn(masterKey, "events", row.content)).toBe(plaintext);

    handle = openStreamDb(tmpDir, masterKey);
  });

  it("strings without enc: prefix pass through decryptFromColumn unchanged", () => {
    expect(decryptFromColumn(masterKey, "events", "plain-string")).toBe(
      "plain-string"
    );
  });

  it("ciphertext from one table cannot be decrypted with another table's key", () => {
    const plaintext = "secret";
    const eventsCipher = encryptForColumn(masterKey, "events", plaintext);
    expect(() => decryptFromColumn(masterKey, "threads", eventsCipher)).toThrow();
  });

  it("ciphertext is non-deterministic across calls (IV randomized per encrypt)", () => {
    const plaintext = "same input";
    const a = encryptForColumn(masterKey, "events", plaintext);
    const b = encryptForColumn(masterKey, "events", plaintext);
    expect(a).not.toBe(b);
    expect(decryptFromColumn(masterKey, "events", a)).toBe(plaintext);
    expect(decryptFromColumn(masterKey, "events", b)).toBe(plaintext);
  });

  it("JSON helpers round-trip arrays and objects", () => {
    const value = { tags: ["a", "b"], n: 42 };
    const ciphertext = encryptJsonForColumn(masterKey, "threads", value);
    expect(ciphertext.startsWith("enc:")).toBe(true);
    expect(decryptJsonFromColumn(masterKey, "threads", ciphertext)).toEqual(value);
  });

  it("the on-disk SQLite file contains no plaintext substring", () => {
    const plaintext = "needle-in-haystack-XYZZY";
    handle.db
      .prepare(
        `INSERT INTO events
         (event_uuid, surface, channel_ref, side, author_ref, content, content_kind, ts_ms, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "evt-x",
        "discord",
        encryptForColumn(masterKey, "events", "{}"),
        "inbound",
        encryptForColumn(masterKey, "events", "{}"),
        encryptForColumn(masterKey, "events", plaintext),
        "text",
        Date.now(),
        Date.now()
      );
    closeStreamDb(handle);

    const dbBytes = fs.readFileSync(handle.dbPath);
    expect(dbBytes.includes(Buffer.from(plaintext))).toBe(false);

    handle = openStreamDb(tmpDir, masterKey);
  });
});
