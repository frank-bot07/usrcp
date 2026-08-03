import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db, LegacyPemIdentityError, assertNoLegacyPemIdentities } from "../db.js";
import { canonicalKeyId } from "../auth.js";

/**
 * Upgrade guard for #176. The fix keys every identity off the canonical
 * SPKI-DER id, but migrate() only runs CREATE ... IF NOT EXISTS, so an
 * in-place upgrade of a pre-#176 database (raw-PEM identities) would silently
 * serve traffic against a mixed schema: a legacy revoked-key PEM row would stop
 * matching the canonical id, un-revoking every revoked key, and active users
 * would authenticate into fresh empty canonical tenants while their data stayed
 * under the raw PEM.
 *
 * usrcp-cloud is pre-launch and its databases are disposable, so migrate()
 * refuses to serve any database that still holds PEM identities (via
 * assertNoLegacyPemIdentities) and directs the operator to reset it, rather
 * than attempting a risky PEM->canonical rewrite. We exercise the guard
 * directly because pg-mem cannot re-run the full schema batch that migrate()
 * applies first.
 */
const canonId = (pem: string): string => canonicalKeyId(crypto.createPublicKey(pem));

let db: Db;

beforeEach(async () => {
  const env = makeMemDb();
  db = env.db;
  await db.migrate(); // creates the schema AND runs the guard on an empty DB
});

afterEach(async () => {
  await db.close();
});

describe("legacy-PEM identity upgrade guard (#176)", () => {
  it("migrate() succeeds on a fresh database (guard runs clean)", async () => {
    // beforeEach already migrated once without throwing; the guard is a no-op
    // on the empty canonical schema. Re-running the guard is also a no-op.
    await expect(assertNoLegacyPemIdentities(db)).resolves.toBeUndefined();
    await expect(assertNoLegacyPemIdentities(db)).resolves.toBeUndefined();
  });

  it("passes when identities are already canonical", async () => {
    const { publicKeyPem } = makeKeyPair();
    await db.query("INSERT INTO users (public_key) VALUES ($1)", [canonId(publicKeyPem)]);
    await expect(assertNoLegacyPemIdentities(db)).resolves.toBeUndefined();
  });

  it("refuses a legacy PEM user row", async () => {
    const { publicKeyPem } = makeKeyPair();
    await db.query("INSERT INTO users (public_key) VALUES ($1)", [publicKeyPem]);

    await expect(assertNoLegacyPemIdentities(db)).rejects.toBeInstanceOf(LegacyPemIdentityError);
    await expect(assertNoLegacyPemIdentities(db)).rejects.toThrow(/users\.public_key/);
  });

  it("refuses a legacy revoked_keys row, so a revoked key cannot become usable after upgrade", async () => {
    const k1 = makeKeyPair();
    const k2 = makeKeyPair();
    // Pre-#176 shape: revoked_keys stores the raw PEM for both the revoked key
    // and its rotation pointer.
    await db.query(
      "INSERT INTO revoked_keys (public_key, rotated_to) VALUES ($1, $2)",
      [k1.publicKeyPem, k2.publicKeyPem]
    );

    let err: unknown;
    await assertNoLegacyPemIdentities(db).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(LegacyPemIdentityError);
    // Both the revoked key and its rotation pointer are reported.
    expect((err as Error).message).toContain("revoked_keys.public_key");
    expect((err as Error).message).toContain("revoked_keys.rotated_to");
  });

  it("reports a legacy child-table identity (pairing owner)", async () => {
    const { publicKeyPem } = makeKeyPair();
    // A pre-#176 database is uniformly PEM: owner_public_key FKs to
    // users(public_key), so the legacy user row and the pairing owner share the
    // same raw PEM. The guard reports the child column alongside users.
    await db.query("INSERT INTO users (public_key) VALUES ($1)", [publicKeyPem]);
    await db.query(
      `INSERT INTO pairing_bundles (code, owner_public_key, encrypted_bundle, expires_at)
       VALUES ('99990000', $1, 'enc:X', now() + interval '30 minutes')`,
      [publicKeyPem]
    );
    await expect(assertNoLegacyPemIdentities(db)).rejects.toThrow(/pairing_bundles\.owner_public_key/);
  });
});
