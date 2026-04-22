import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { setUserSlug, initializeMasterKey } from "../encryption.js";
import { Ledger } from "../ledger.js";
import { initializeIdentity } from "../crypto.js";
import { updateConfig, readConfig } from "../config.js";
import { syncPush, syncPull, syncStatus } from "../sync.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-sync-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function initFreshLedger(): Ledger {
  // Dev mode (no passphrase → random key, no scrypt). initializeMasterKey
  // creates master.key; initializeIdentity creates identity.json +
  // private.pem (encrypted by master key).
  const masterKey = initializeMasterKey();
  initializeIdentity(masterKey);
  return new Ledger();
}

function appendThreeEvents(ledger: Ledger): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { event_id } = ledger.appendEvent(
      { domain: "coding", summary: `s${i}`, intent: "test", outcome: "success" },
      "test"
    );
    ids.push(event_id);
  }
  return ids;
}

describe("syncStatus", () => {
  it("reports zero pending on a fresh ledger with no config", () => {
    initFreshLedger().close();
    const s = syncStatus();
    expect(s.cloud_endpoint).toBe(null);
    expect(s.local_max_seq).toBe(0);
    expect(s.pending_events_to_push).toBe(0);
    expect(s.last_sync_at).toBe(null);
  });

  it("reports pending count = local_max_seq - last_push_local_seq", () => {
    const ledger = initFreshLedger();
    appendThreeEvents(ledger);
    ledger.close();
    updateConfig({ last_push_local_seq: 1 });

    const s = syncStatus();
    expect(s.local_max_seq).toBe(3);
    expect(s.last_push_local_seq).toBe(1);
    expect(s.pending_events_to_push).toBe(2);
  });
});

describe("syncPush", () => {
  it("refuses when cloud_endpoint is unset", async () => {
    initFreshLedger().close();
    await expect(syncPush()).rejects.toThrow(/cloud_endpoint/);
  });

  it("posts ciphertext-only payload signed with the user's key", async () => {
    const ledger = initFreshLedger();
    appendThreeEvents(ledger);
    ledger.close();
    updateConfig({ cloud_endpoint: "https://cloud.example.test" });

    let captured: { url: string; init: any } | null = null;
    const mockFetch = (async (url: string, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({ accepted: [{}, {}, {}], cursor: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await syncPush({ fetchImpl: mockFetch });
    expect(res.pushed).toBe(3);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://cloud.example.test/v1/events");
    expect(captured!.init.method).toBe("POST");

    // Verify signing headers present
    const headers = captured!.init.headers as Record<string, string>;
    // Header is base64-encoded PEM (raw PEM has newlines, invalid in headers)
    expect(Buffer.from(headers["x-usrcp-publickey"], "base64").toString()).toContain("BEGIN PUBLIC KEY");
    expect(headers["x-usrcp-timestamp"]).toMatch(/^\d+$/);
    expect(headers["x-usrcp-nonce"]).toMatch(/^[0-9a-f]+$/);
    expect(headers["x-usrcp-signature"].length).toBeGreaterThan(40);

    // Verify payload contains ciphertext, not plaintext
    const body = JSON.parse(captured!.init.body as string);
    expect(body.events).toHaveLength(3);
    for (const e of body.events) {
      expect(e.summary_enc.startsWith("enc:")).toBe(true);
      // No plaintext domain leak — domain is the HMAC pseudonym
      expect(e.domain_pseudonym).toMatch(/^d_[0-9a-f]{12}$/);
    }

    const cfg = readConfig();
    expect(cfg.last_push_local_seq).toBe(3);
    expect(cfg.last_sync_at).toBeDefined();
  });

  it("is a no-op when caught up", async () => {
    const ledger = initFreshLedger();
    appendThreeEvents(ledger);
    ledger.close();
    updateConfig({
      cloud_endpoint: "https://x",
      last_push_local_seq: 3,
    });

    let called = false;
    const mockFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncPush({ fetchImpl: mockFetch });
    expect(res.pushed).toBe(0);
    expect(called).toBe(false);
  });

  it("throws on 4xx response", async () => {
    const ledger = initFreshLedger();
    appendThreeEvents(ledger);
    ledger.close();
    updateConfig({ cloud_endpoint: "https://x" });

    const mockFetch = (async () =>
      new Response(JSON.stringify({ error: "STALE_REQUEST" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(syncPush({ fetchImpl: mockFetch })).rejects.toThrow(/401/);
  });
});

describe("syncPull", () => {
  it("applies new remote events and skips duplicates on re-pull", async () => {
    // Bootstrap a real ciphertext row via local append, capture the raw
    // row bytes, then simulate them coming from "the cloud". This is
    // honest to production because cross-device sync requires a shared
    // passphrase (= shared master key); the pulled ciphertext must
    // actually decrypt with the local key, otherwise the blind-index
    // rebuild on next open would fail.
    const ledger = initFreshLedger();
    const { event_id } = ledger.appendEvent(
      { domain: "coding", summary: "real-event", intent: "test", outcome: "success" },
      "test"
    );
    const db = (ledger as any).db as import("better-sqlite3").Database;
    const row = db
      .prepare(
        `SELECT event_id, timestamp, platform, domain, summary, intent,
                outcome, detail, artifacts, tags, session_id, parent_event_id
         FROM timeline_events WHERE event_id = ?`
      )
      .get(event_id) as any;
    // Clear local so pull has something to do
    db.prepare("DELETE FROM timeline_events").run();
    db.prepare("DELETE FROM blind_index").run();
    ledger.close();

    const cloudRow = {
      event_id: row.event_id,
      client_timestamp: row.timestamp,
      ledger_sequence: 1,
      domain_pseudonym: row.domain,
      platform_enc: row.platform,
      summary_enc: row.summary,
      intent_enc: row.intent,
      outcome_enc: row.outcome,
      detail_enc: row.detail,
      artifacts_enc: row.artifacts,
      tags_enc: row.tags,
    };

    updateConfig({ cloud_endpoint: "https://x" });

    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ events: [cloudRow], cursor: 1 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const first = await syncPull({ fetchImpl: mockFetch });
    expect(first.pulled).toBe(1);
    expect(first.applied).toBe(1);
    expect(first.cursor).toBe(1);

    // Re-pull: event_id exists, applied=0
    const second = await syncPull({ fetchImpl: mockFetch });
    expect(second.pulled).toBe(1);
    expect(second.applied).toBe(0);

    expect(calls).toBe(2);
  });

  it("throws on 401", async () => {
    initFreshLedger().close();
    updateConfig({ cloud_endpoint: "https://x" });
    const mockFetch = (async () =>
      new Response(JSON.stringify({ error: "BAD_SIGNATURE" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(syncPull({ fetchImpl: mockFetch })).rejects.toThrow(/401/);
  });
});
