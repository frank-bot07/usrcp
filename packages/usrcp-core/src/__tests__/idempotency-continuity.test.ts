import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../ledger/index.js";
import {
  setUserSlug,
  getUserDir,
  decrypt,
  deriveGlobalEncryptionKey,
  zeroBuffer,
} from "../encryption.js";
import { getDecryptedPrivateKeyPem } from "../crypto.js";
import { pairInit, pairJoin } from "../pair.js";

// #171 part 2: idempotency dedup must survive master-key rotation, reopen,
// and pairing to a fresh device. The rotation-stable lookup secret is frozen
// from the first-open derived key, persisted encrypted under the global key
// at keys/idempotency.secret, re-encrypted (same value) on rotation, and
// carried in the pairing bundle.

const EVENT = {
  domain: "coding",
  summary: "Deployed the release",
  intent: "ship",
  outcome: "success" as const,
};

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-idem-cont-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function dbPathIn(home: string): string {
  return path.join(home, "ledger-under-test.db");
}

function secretFilePath(): string {
  return path.join(getUserDir(), "keys", "idempotency.secret");
}

describe("idempotency dedup across rotation (#171 part 2)", () => {
  it("dev-mode rotation: same key still dedups, in-session and after reopen", () => {
    const dbPath = dbPathIn(tmpHome);
    let ledger = new Ledger(dbPath);
    const first = ledger.appendEvent(EVENT, "test", "idem-dev-1");
    expect(first.duplicate).toBeUndefined();

    ledger.rotateKey();

    const inSession = ledger.appendEvent(EVENT, "test", "idem-dev-1");
    expect(inSession.duplicate).toBe(true);
    expect(inSession.event_id).toBe(first.event_id);
    ledger.close();

    ledger = new Ledger(dbPath);
    const afterReopen = ledger.appendEvent(EVENT, "test", "idem-dev-1");
    expect(afterReopen.duplicate).toBe(true);
    expect(afterReopen.event_id).toBe(first.event_id);
    ledger.close();
  });

  it("passphrase rotation: same key still dedups after reopen with the new passphrase", () => {
    const dbPath = dbPathIn(tmpHome);
    let ledger = new Ledger(dbPath, "first-passphrase");
    const first = ledger.appendEvent(EVENT, "test", "idem-pass-1");

    ledger.rotateKey("second-passphrase");
    const inSession = ledger.appendEvent(EVENT, "test", "idem-pass-1");
    expect(inSession.duplicate).toBe(true);
    ledger.close();

    ledger = new Ledger(dbPath, "second-passphrase");
    const afterReopen = ledger.appendEvent(EVENT, "test", "idem-pass-1");
    expect(afterReopen.duplicate).toBe(true);
    expect(afterReopen.event_id).toBe(first.event_id);
    ledger.close();
  });

  it("stores the secret only as ciphertext (0600) and re-encrypts the SAME value on rotation", () => {
    const dbPath = dbPathIn(tmpHome);
    const ledger = new Ledger(dbPath, "at-rest-pass");

    const file = secretFilePath();
    expect(fs.existsSync(file)).toBe(true);
    const before = fs.readFileSync(file, "utf-8").trim();
    expect(before.startsWith("enc:")).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const oldGlobal = deriveGlobalEncryptionKey((ledger as any).masterKey);
    const plainBefore = decrypt(before, oldGlobal);
    zeroBuffer(oldGlobal);

    ledger.rotateKey("at-rest-pass-2");

    const after = fs.readFileSync(file, "utf-8").trim();
    expect(after.startsWith("enc:")).toBe(true);
    // Re-encrypted under the new global key (fresh IV at minimum), but the
    // decrypted VALUE is byte-identical: that value stability is the whole
    // fix.
    expect(after).not.toBe(before);
    const newGlobal = deriveGlobalEncryptionKey((ledger as any).masterKey);
    const plainAfter = decrypt(after, newGlobal);
    zeroBuffer(newGlobal);
    expect(plainAfter).toBe(plainBefore);
    expect(Buffer.from(plainAfter, "base64").length).toBe(32);
    ledger.close();
  });
});

describe("rotate, pair a fresh device, pull, dedup (#171 part 2 + pairing propagation)", () => {
  function pairingStub() {
    const state: { bundles: Map<string, string> } = { bundles: new Map() };
    const impl = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url);
      const method = (init?.method ?? "GET") as string;
      if (method === "POST" && u.pathname === "/v1/pairing/init") {
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        state.bundles.set(parsed.code, parsed.encrypted_bundle);
        return new Response(
          JSON.stringify({ ok: true, expires_at: new Date(Date.now() + 600_000).toISOString() }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method === "GET" && u.pathname.startsWith("/v1/pairing/claim/")) {
        const code = u.pathname.split("/").pop()!;
        const bundle = state.bundles.get(code);
        if (!bundle) return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
        return new Response(
          JSON.stringify({ encrypted_bundle: bundle }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: "UNEXPECTED" }), { status: 500 });
    };
    return { state, fetchImpl: impl as unknown as typeof fetch };
  }

  it("a device paired after rotation reproduces pre-rotation hashes: pulled event dedups a re-append", async () => {
    // --- Device A: append under passphrase 1, then rotate to passphrase 2.
    const homeA = tmpHome;
    const ledgerA = new Ledger(dbPathIn(homeA), "pair-pass-1");
    const appended = ledgerA.appendEvent(EVENT, "test", "cross-device-key");
    ledgerA.rotateKey("pair-pass-2");

    const userDirA = getUserDir();
    const secretFileA = fs.readFileSync(secretFilePath(), "utf-8").trim();
    const publicKeyPem = fs.readFileSync(path.join(userDirA, "keys", "public.pem"), "utf-8");
    const privateKeyPem = getDecryptedPrivateKeyPem((ledgerA as any).masterKey);

    const wireEvents = ledgerA.listEncryptedEventsAbove(0).map((e: any) => ({
      event_id: e.event_id,
      client_timestamp: e.timestamp,
      domain_pseudonym: e.domain,
      platform_enc: e.platform,
      summary_enc: e.summary,
      intent_enc: e.intent,
      outcome_enc: e.outcome,
      detail_enc: e.detail,
      artifacts_enc: e.artifacts,
      tags_enc: e.tags,
      session_id_enc: e.session_id,
      parent_event_id_enc: e.parent_event_id,
      // The push/pull wire carries the opaque hash (aliased idempotency_key).
      idempotency_key: e.idempotency_key,
    }));
    expect(wireEvents).toHaveLength(1);
    expect(wireEvents[0].idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    const domainMaps = ledgerA.listDomainMaps();

    const { fetchImpl } = pairingStub();
    const initResult = await pairInit({
      userDir: userDirA,
      publicKeyPem,
      privateKeyPem,
      endpoint: "https://relay.test",
      fetchImpl,
    });
    ledgerA.close();

    // --- Device B: fresh HOME, join with the post-rotation passphrase.
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-idem-deviceB-"));
    try {
      process.env.HOME = homeB;
      const joined = await pairJoin(initResult.pairingString, {
        userDir: getUserDir(),
        passphrase: "pair-pass-2",
        endpoint: "https://relay.test",
        fetchImpl,
      });
      expect(joined.user_id).toBeTruthy();

      // The encrypted secret file was propagated byte-for-byte.
      expect(fs.readFileSync(secretFilePath(), "utf-8").trim()).toBe(secretFileA);

      const ledgerB = new Ledger(dbPathIn(homeB), "pair-pass-2");
      const applied = ledgerB.applyPulledEvents(wireEvents, domainMaps);
      expect(applied).toBe(1);

      // The regression itself: appending with the ORIGINAL caller key on the
      // fresh post-rotation device returns duplicate:true against the pulled
      // event instead of silently storing a second copy.
      const reappend = ledgerB.appendEvent(EVENT, "test", "cross-device-key");
      expect(reappend.duplicate).toBe(true);
      expect(reappend.event_id).toBe(appended.event_id);
      ledgerB.close();
    } finally {
      process.env.HOME = tmpHome;
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });

  it("applyPulledEvents falls back to the cloud: placeholder when the pulled hash collides locally", () => {
    const ledger = new Ledger(dbPathIn(tmpHome));
    ledger.appendEvent(EVENT, "test", "collide-key");
    const localHash = (ledger as any).db
      .prepare("SELECT idempotency_hash FROM timeline_events LIMIT 1")
      .get().idempotency_hash as string;

    const pseudonym = (ledger as any).db
      .prepare("SELECT pseudonym, encrypted_name FROM domain_map LIMIT 1")
      .get();
    const foreignId = "01FAKEEVENTFROMOTHERDEVICE";
    const applied = ledger.applyPulledEvents(
      [
        {
          event_id: foreignId,
          client_timestamp: new Date().toISOString(),
          domain_pseudonym: pseudonym.pseudonym,
          summary_enc: "opaque-remote-ciphertext",
          idempotency_key: localHash,
        },
      ],
      []
    );
    expect(applied).toBe(1);
    const stored = (ledger as any).db
      .prepare("SELECT idempotency_hash FROM timeline_events WHERE event_id = ?")
      .get(foreignId);
    expect(stored.idempotency_hash).toBe(`cloud:${foreignId}`);
    ledger.close();
  });
});
