import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Ledger,
  RotationRateLimitedError,
  RotationDamagedRowsError,
} from "../ledger/index.js";

let ledger: Ledger;
let dbPath: string;
let prevInterval: string | undefined;

beforeEach(() => {
  // Each test in this file controls the rate-limit env explicitly. The
  // global vitest-setup.ts disables the limit; we capture/restore so
  // individual tests can re-enable it for their assertions.
  prevInterval = process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS;
  dbPath = path.join(os.tmpdir(), `usrcp-rotate-safety-${Date.now()}-${Math.random()}.db`);
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  if (prevInterval === undefined) {
    delete process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS;
  } else {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = prevInterval;
  }
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe("rotateKey rate limit (v0.1.5)", () => {
  it("first rotation succeeds and stamps last_rotation_at", () => {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "24";

    const before = (ledger as any).db
      .prepare("SELECT last_rotation_at FROM rotation_state WHERE id = 1")
      .get();
    expect(before.last_rotation_at).toBeNull();

    const result = ledger.rotateKey();
    expect(result.version).toBeGreaterThan(0);

    const after = (ledger as any).db
      .prepare("SELECT last_rotation_at FROM rotation_state WHERE id = 1")
      .get();
    expect(after.last_rotation_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("second rotation within the window throws RotationRateLimitedError", () => {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "24";
    ledger.rotateKey();

    let caught: unknown;
    try {
      ledger.rotateKey();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RotationRateLimitedError);
    const err = caught as RotationRateLimitedError;
    expect(err.minIntervalHours).toBe(24);
    expect(err.hoursSinceLast).toBeGreaterThanOrEqual(0);
    expect(err.lastRotationAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("force_rate_limit=true bypasses the window", () => {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "24";
    ledger.rotateKey();
    const second = ledger.rotateKey(undefined, { force_rate_limit: true });
    expect(second.version).toBeGreaterThan(1);
  });

  it("USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS=0 disables the limit", () => {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "0";
    ledger.rotateKey();
    const second = ledger.rotateKey();
    expect(second.version).toBeGreaterThan(1);
  });

  it("rate limit refuses BEFORE generating a new key (no version bump on refusal)", () => {
    process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "24";
    const first = ledger.rotateKey();
    const versionAfterFirst = first.version;

    try { ledger.rotateKey(); } catch {}

    // key.version file must NOT have advanced on a rate-limited refusal.
    const keyVersionPath = path.join(
      path.dirname(path.dirname(dbPath)),
      "keys",
      "key.version",
    );
    if (fs.existsSync(keyVersionPath)) {
      const onDisk = parseInt(fs.readFileSync(keyVersionPath, "utf-8"), 10);
      expect(onDisk).toBe(versionAfterFirst);
    }

    const row = (ledger as any).db
      .prepare("SELECT pending_version FROM rotation_state WHERE id = 1")
      .get();
    expect(row.pending_version).toBeNull();
  });
});

describe("rotateKey damaged-row refusal (v0.1.5)", () => {
  function plantDamagedEvent(): string {
    ledger.appendEvent({
      domain: "test", summary: "good event", intent: "t", outcome: "success",
    }, "test");
    ledger.appendEvent({
      domain: "test", summary: "bad event", intent: "t", outcome: "success",
    }, "test");
    const target = ledger.getTimeline({ last_n: 1 })[0];
    const raw = (ledger as any).db
      .prepare("SELECT summary FROM timeline_events WHERE event_id = ?")
      .get(target.event_id);
    const parts = raw.summary.split(":");
    const buf = Buffer.from(parts[1], "base64");
    buf[buf.length - 16] ^= 0xff;
    const corrupted = "enc:" + buf.toString("base64");
    (ledger as any).db
      .prepare("UPDATE timeline_events SET summary = ? WHERE event_id = ?")
      .run(corrupted, target.event_id);
    return target.event_id;
  }

  it("throws RotationDamagedRowsError when any row fails MAC verification", () => {
    plantDamagedEvent();
    let caught: unknown;
    try { ledger.rotateKey(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RotationDamagedRowsError);
    expect((caught as RotationDamagedRowsError).damagedCount).toBeGreaterThanOrEqual(1);
  });

  it("damaged-row refusal rolls back: no rotation_state mutation", () => {
    plantDamagedEvent();
    const before = (ledger as any).db
      .prepare("SELECT pending_key, pending_version, last_rotation_at FROM rotation_state WHERE id = 1")
      .get();
    expect(before.pending_key).toBeNull();
    expect(before.last_rotation_at).toBeNull();

    try { ledger.rotateKey(); } catch {}

    const after = (ledger as any).db
      .prepare("SELECT pending_key, pending_version, last_rotation_at FROM rotation_state WHERE id = 1")
      .get();
    expect(after.pending_key).toBeNull();
    expect(after.pending_version).toBeNull();
    expect(after.last_rotation_at).toBeNull();
  });

  it("force_skip_damaged=true proceeds and reports the skipped count", () => {
    plantDamagedEvent();
    const result = ledger.rotateKey(undefined, { force_skip_damaged: true });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.reencrypted).toBeGreaterThanOrEqual(1);
  });
});
