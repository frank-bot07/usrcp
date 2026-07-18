import * as crypto from "node:crypto";
import { Ledger } from "./core.js";
import {
  deriveGlobalEncryptionKey,
  deriveDomainEncryptionKey,
  deriveBlindIndexKey,
  encrypt,
  decrypt,
  isEncrypted,
  zeroBuffer,
  prepareKeyRotation,
  commitKeyRotation,
  serializePendingKeyFiles,
} from "../encryption.js";
import { prepareReencryptedPrivatePem } from "../crypto.js";
import { safeJsonParse } from "./helpers.js";

/**
 * Thrown when rotateKey is invoked sooner than
 * USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS (default 24h) since the last
 * successful rotation. Defense against reflexive agent callers that
 * loop rotation — see v0.1.5 fix for the 1022-rotation incident.
 */
export class RotationRateLimitedError extends Error {
  readonly hoursSinceLast: number;
  readonly minIntervalHours: number;
  readonly lastRotationAt: string;
  constructor(hoursSinceLast: number, minIntervalHours: number, lastRotationAt: string) {
    super(
      `Rotation refused: last rotation was ${hoursSinceLast.toFixed(2)}h ago, ` +
      `minimum interval is ${minIntervalHours}h. Set force_rate_limit=true if the user explicitly requested this rotation, ` +
      `or override the interval via USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS.`
    );
    this.name = "RotationRateLimitedError";
    this.hoursSinceLast = hoursSinceLast;
    this.minIntervalHours = minIntervalHours;
    this.lastRotationAt = lastRotationAt;
  }
}

/**
 * Thrown when rotation would skip rows that fail MAC verification
 * under the current key. Once skipped, those rows can never be
 * decrypted again — the next rotation discards the only key that
 * could read them. Force via force_skip_damaged=true after taking
 * a snapshot.
 */
export class RotationDamagedRowsError extends Error {
  readonly damagedCount: number;
  constructor(damagedCount: number) {
    super(
      `Rotation refused: ${damagedCount} row(s) cannot be decrypted under the current key ` +
      `and would be permanently lost if rotation proceeded. Take a snapshot ` +
      `(\`usrcp snapshot\`) and inspect, then re-call with force_skip_damaged=true to ` +
      `proceed and accept the data loss.`
    );
    this.name = "RotationDamagedRowsError";
    this.damagedCount = damagedCount;
  }
}

declare module "./core.js" {
  interface Ledger {
    rebuildBlindIndex(): void;
    rotateKey(
      passphrase?: string,
      opts?: {
        /**
         * Invoked after the DB-rotation transaction commits and the
         * new key files land on disk, but BEFORE the in-memory
         * masterKey is updated. Receives both the old and new master
         * key buffers (still allocated). Use this to re-encrypt
         * out-of-band data (adapter configs, etc.) that's keyed off
         * the master key but not stored in the ledger DB.
         *
         * If the callback throws, the rotation is still considered
         * complete (the master key on disk and in the DB has
         * rotated); the error is surfaced via console.warn so callers
         * can inspect, but the rotation itself succeeds. Callers that
         * need richer error reporting should catch internally and
         * accumulate diagnostics.
         */
        onKeysReady?: (oldKey: Buffer, newKey: Buffer) => void;
        /**
         * Bypass the 24h (or USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS) rate
         * limit. Set only when the user has explicitly requested this
         * rotation.
         */
        force_rate_limit?: boolean;
        /**
         * Proceed even if some rows fail MAC verification and would
         * be permanently lost. Equivalent to acknowledging data loss.
         */
        force_skip_damaged?: boolean;
      },
    ): { version: number; reencrypted: number; skipped: number };
  }
}

Ledger.prototype.rebuildBlindIndex = function (this: Ledger): void {
  this.db.exec("DELETE FROM blind_index");
  const events = this.db
    .prepare("SELECT event_id, summary, intent, tags, domain FROM timeline_events")
    .all() as any[];
  const insertToken = this.db.prepare(
    "INSERT INTO blind_index (event_id, token, domain) VALUES (?, ?, ?)"
  );
  const transaction = this.db.transaction(() => {
    for (const event of events) {
      try {
        const realDomain = this.resolveDomain(event.domain);
        const summary = this.decryptForDomain(event.summary || "", realDomain);
        const intent = this.decryptForDomain(event.intent || "", realDomain);
        const tagsDecrypted = this.decryptForDomain(event.tags || "[]", realDomain);
        const tagsArray = safeJsonParse<string[]>(tagsDecrypted, []);
        const searchableText = [summary, intent, ...tagsArray].join(" ");
        const tokens = this.getBlindTokens(searchableText, realDomain);
        for (const token of tokens) {
          insertToken.run(event.event_id, token, event.domain); // Store with pseudonym
        }
      } catch {
        // Tampered / unreadable event — skip blind tokens for it.
        // The row itself is preserved for audit; searches will miss it.
      }
    }
  });
  transaction();
};

Ledger.prototype.rotateKey = function (
  this: Ledger,
  passphrase?: string,
  opts?: {
    onKeysReady?: (oldKey: Buffer, newKey: Buffer) => void;
    force_rate_limit?: boolean;
    force_skip_damaged?: boolean;
  },
): { version: number; reencrypted: number; skipped: number } {
  // Phase 0: rate-limit. Without this, an agent on a reflexive
  // tool-call loop can advance key.version hundreds of times in
  // minutes; each rotation that skips a damaged row discards the
  // only key that could ever read it. See v0.1.5 fix.
  const minIntervalRaw = process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS;
  const minIntervalHours = minIntervalRaw !== undefined
    ? Math.max(0, Number(minIntervalRaw) || 0)
    : 24;
  if (minIntervalHours > 0 && !opts?.force_rate_limit) {
    const row = this.db
      .prepare("SELECT last_rotation_at FROM rotation_state WHERE id = 1")
      .get() as { last_rotation_at: string | null } | undefined;
    if (row?.last_rotation_at) {
      // SQLite datetime('now') returns UTC without a tz suffix; append Z for parsing.
      const lastMs = Date.parse(row.last_rotation_at + "Z");
      if (Number.isFinite(lastMs)) {
        const hoursSince = (Date.now() - lastMs) / 3_600_000;
        if (hoursSince < minIntervalHours) {
          throw new RotationRateLimitedError(hoursSince, minIntervalHours, row.last_rotation_at);
        }
      }
    }
  }

  // Phase 1: Prepare new key material WITHOUT writing to disk
  const { oldKey, newKey, version, pendingFiles } = prepareKeyRotation(this.masterKey, passphrase);

  // Append a re-encrypted private.pem entry to pendingFiles so the
  // Ed25519 identity key stays decryptable under the new master key
  // after rotation. Without this, private.pem would remain sealed
  // under the OLD globalKey and any post-rotation
  // getDecryptedPrivateKeyPem call would fail. Including it in
  // pendingFiles also means it goes through the durable-replay path:
  // pending_files_json captures it inside the DB transaction, so a
  // crash between the transaction commit and commitKeyRotation
  // recovers correctly on next Ledger open.
  const privatePemEntry = prepareReencryptedPrivatePem(oldKey, newKey);
  if (privatePemEntry) pendingFiles.push(privatePemEntry);
  let reencrypted = 0;
  // Rotation and tampered rows: if a row fails to decrypt with the old key
  // (GCM auth failure from tampering, corruption, or key mismatch) it is
  // unrecoverable — the plaintext cannot be produced to re-encrypt. Rather
  // than failing the entire rotation, we log a warning, leave the row in
  // place, and continue. The row remains unreadable under the new key too,
  // but its presence is preserved so external audits can see it.
  // Callers are informed via the returned `skipped` count and an
  // audit log entry.
  let skipped = 0;

  const transaction = this.db.transaction(() => {
    const oldGlobalKey = deriveGlobalEncryptionKey(oldKey);
    const newGlobalKey = deriveGlobalEncryptionKey(newKey);

    const reencGlobal = (val: string) => {
      const plain = isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
      return encrypt(plain, newGlobalKey);
    };

    // Build old pseudonym → real domain name mapping FIRST
    const domainMaps = this.db.prepare("SELECT pseudonym, encrypted_name FROM domain_map").all() as any[];
    const pseudoToReal = new Map<string, string>();
    const domainNames: string[] = [];
    for (const dm of domainMaps) {
      const realName = isEncrypted(dm.encrypted_name) ? decrypt(dm.encrypted_name, oldGlobalKey) : dm.encrypted_name;
      pseudoToReal.set(dm.pseudonym, realName);
      domainNames.push(realName);
    }

    // Precompute per-domain key material once. Without this, HKDF runs
    // twice per row for events, and twice again per row for facts —
    // O(rows) cost where O(domains) is enough.
    interface DomainKeyBundle {
      oldDomainKey: Buffer;
      newDomainKey: Buffer;
      newBlindKey: Buffer;
      oldPseudo: string;
      newPseudo: string;
    }
    const domainKeyCache = new Map<string, DomainKeyBundle>();
    const pseudoForName = (key: Buffer, name: string) =>
      "d_" + crypto.createHmac("sha256", key).update(`usrcp-domain-pseudo:${name}`).digest("hex").slice(0, 12);
    for (const name of domainNames) {
      domainKeyCache.set(name, {
        oldDomainKey: deriveDomainEncryptionKey(oldKey, name),
        newDomainKey: deriveDomainEncryptionKey(newKey, name),
        newBlindKey: deriveBlindIndexKey(newKey, name),
        oldPseudo: pseudoForName(oldKey, name),
        newPseudo: pseudoForName(newKey, name),
      });
    }

    // Re-encrypt all timeline events AND update their domain pseudonym
    // in a single UPDATE — no separate per-domain pass afterwards.
    const events = this.db
      .prepare("SELECT event_id, domain, summary, intent, outcome, platform, detail, artifacts, tags, session_id, parent_event_id, channel_id, thread_id, external_user_id FROM timeline_events")
      .all() as any[];

    const updateEvent = this.db.prepare(
      `UPDATE timeline_events SET domain=?, summary=?, intent=?, outcome=?, platform=?, detail=?, artifacts=?, tags=?, session_id=?, parent_event_id=?, channel_id=?, thread_id=?, external_user_id=?, channel_hash=? WHERE event_id=?`
    );

    const reencGlobalNullable = (val: string | null): string | null => {
      if (!val) return null;
      const plain = isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
      return encrypt(plain, newGlobalKey);
    };

    const decryptGlobalMaybe = (val: string | null): string | null => {
      if (!val) return null;
      return isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
    };

    for (const e of events) {
      const realDomain = pseudoToReal.get(e.domain) || e.domain;
      const bundle = domainKeyCache.get(realDomain);
      if (!bundle) continue; // domain not in map — should not happen

      const reenc = (val: string | null) => {
        if (!val) return null;
        const plain = isEncrypted(val) ? decrypt(val, bundle.oldDomainKey) : val;
        return encrypt(plain, bundle.newDomainKey);
      };

      try {
        // Platform-adapter columns use the global key, not the per-domain
        // key. channel_hash is re-derived under the new master key.
        const channelIdPlain = decryptGlobalMaybe(e.channel_id);
        const newChannelHash = channelIdPlain
          ? crypto.createHmac("sha256", newKey).update(`usrcp-channel-id:${channelIdPlain}`).digest("hex")
          : null;

        updateEvent.run(
          bundle.newPseudo,
          reenc(e.summary), reenc(e.intent), reenc(e.outcome), reenc(e.platform),
          reenc(e.detail), reenc(e.artifacts), reenc(e.tags),
          reenc(e.session_id), reenc(e.parent_event_id),
          reencGlobalNullable(e.channel_id),
          reencGlobalNullable(e.thread_id),
          reencGlobalNullable(e.external_user_id),
          newChannelHash,
          e.event_id
        );
        reencrypted++;
      } catch (err) {
        // Any decrypt failure means a field is damaged and the row
        // is unrecoverable. Leave it in place (old ciphertext, old
        // domain pseudo) so external audits can see the damaged row,
        // and continue rotation for the rest of the ledger.
        console.warn(
          `[usrcp] rotateKey: skipping damaged timeline event ${e.event_id}: ${(err as Error).message}`
        );
        skipped++;
      }
    }

    // Now rewrite domain_map with new pseudonyms
    this.db.exec("DELETE FROM domain_map");
    const insertMap = this.db.prepare("INSERT INTO domain_map (pseudonym, encrypted_name) VALUES (?, ?)");
    for (const name of domainNames) {
      const bundle = domainKeyCache.get(name)!;
      insertMap.run(bundle.newPseudo, encrypt(name, newGlobalKey));
    }

    // Re-encrypt domain context with new pseudonyms
    const contexts = this.db.prepare("SELECT domain, context FROM domain_context").all() as any[];
    this.db.exec("DELETE FROM domain_context");
    const insertCtx = this.db.prepare("INSERT INTO domain_context (domain, context, updated_at) VALUES (?, ?, datetime('now'))");
    for (const c of contexts) {
      const realName = pseudoToReal.get(c.domain);
      if (!realName) continue;
      const bundle = domainKeyCache.get(realName)!;
      try {
        const plain = isEncrypted(c.context) ? decrypt(c.context, bundle.oldDomainKey) : c.context;
        insertCtx.run(bundle.newPseudo, encrypt(plain, bundle.newDomainKey));
      } catch (err) {
        // Tampered / corrupted context — leave the old row in place
        // under its old pseudo so it doesn't collide with the rewritten
        // domain_context table.
        console.warn(
          `[usrcp] rotateKey: skipping damaged domain_context for ${c.domain}: ${(err as Error).message}`
        );
        insertCtx.run(c.domain, c.context);
        skipped++;
      }
    }

    // Re-encrypt schemaless_facts using the same per-domain cache.
    const facts = this.db.prepare(
      "SELECT fact_id, domain, namespace, \"key\", value FROM schemaless_facts"
    ).all() as any[];
    const updateFact = this.db.prepare(
      `UPDATE schemaless_facts SET domain = ?, ns_key_hash = ?, namespace = ?, "key" = ?, value = ? WHERE fact_id = ?`
    );
    for (const f of facts) {
      const realDomain = pseudoToReal.get(f.domain) || f.domain;
      const bundle = domainKeyCache.get(realDomain);
      if (!bundle) continue;

      try {
        const nsPlain = isEncrypted(f.namespace) ? decrypt(f.namespace, bundle.oldDomainKey) : f.namespace;
        const keyPlain = isEncrypted(f.key) ? decrypt(f.key, bundle.oldDomainKey) : f.key;
        const valuePlain = isEncrypted(f.value) ? decrypt(f.value, bundle.oldDomainKey) : f.value;

        const newHash = crypto.createHmac("sha256", bundle.newBlindKey)
          .update(`${nsPlain.length}:${nsPlain}|${keyPlain.length}:${keyPlain}`)
          .digest("hex");

        updateFact.run(
          bundle.newPseudo,
          newHash,
          encrypt(nsPlain, bundle.newDomainKey),
          encrypt(keyPlain, bundle.newDomainKey),
          encrypt(valuePlain, bundle.newDomainKey),
          f.fact_id
        );
      } catch (err) {
        // Tampered fact — leave the row in place with old ciphertext
        // and old pseudonym so audits can see it.
        console.warn(
          `[usrcp] rotateKey: skipping damaged fact ${f.fact_id}: ${(err as Error).message}`
        );
        skipped++;
      }
    }

    // Zero the cached per-domain keys. The global keys are zeroed
    // separately in the rotation tail.
    for (const bundle of domainKeyCache.values()) {
      zeroBuffer(bundle.oldDomainKey);
      zeroBuffer(bundle.newDomainKey);
      zeroBuffer(bundle.newBlindKey);
    }

    // Re-encrypt identity
    const identity = this.db.prepare("SELECT * FROM core_identity WHERE id = 1").get() as any;
    this.db.prepare(
      "UPDATE core_identity SET display_name=?, roles=?, expertise_domains=?, communication_style=? WHERE id=1"
    ).run(
      reencGlobal(identity.display_name),
      reencGlobal(identity.roles),
      reencGlobal(identity.expertise_domains),
      reencGlobal(identity.communication_style)
    );

    // Re-encrypt ALL preference fields
    const prefs = this.db.prepare("SELECT * FROM global_preferences WHERE id = 1").get() as any;
    this.db.prepare(
      "UPDATE global_preferences SET language=?, timezone=?, output_format=?, verbosity=?, custom=? WHERE id=1"
    ).run(
      reencGlobal(prefs.language),
      reencGlobal(prefs.timezone),
      reencGlobal(prefs.output_format),
      reencGlobal(prefs.verbosity),
      reencGlobal(prefs.custom)
    );

    // Re-encrypt active_projects
    const projects = this.db.prepare("SELECT * FROM active_projects").all() as any[];
    const updateProject = this.db.prepare(
      "UPDATE active_projects SET name=?, domain=?, status=?, summary=? WHERE project_id=?"
    );
    for (const p of projects) {
      updateProject.run(
        reencGlobal(p.name), reencGlobal(p.domain),
        reencGlobal(p.status), reencGlobal(p.summary), p.project_id
      );
    }

    // Re-encrypt audit_log
    const audits = this.db.prepare("SELECT * FROM audit_log").all() as any[];
    const updateAudit = this.db.prepare(
      "UPDATE audit_log SET agent_id=?, operation=?, scopes_accessed=?, event_ids=?, detail=?, integrity_tag=? WHERE id=?"
    );
    for (const a of audits) {
      const encAgentId = reencGlobal(a.agent_id);
      const encOp = reencGlobal(a.operation);
      const encScopes = a.scopes_accessed ? reencGlobal(a.scopes_accessed) : null;
      const encEvents = a.event_ids ? reencGlobal(a.event_ids) : null;
      const encDetail = a.detail ? reencGlobal(a.detail) : null;
      // Recompute integrity tag with new key
      const payload = [encAgentId, encOp, encScopes || "", encEvents || "", encDetail || ""].join("|");
      const tag = crypto.createHmac("sha256", newGlobalKey).update(payload).digest("hex").slice(0, 32);
      updateAudit.run(encAgentId, encOp, encScopes, encEvents, encDetail, tag, a.id);
    }

    // Damaged-row guard. By default, refuse to advance the key when any
    // row failed to decrypt under the OLD key: each such row is preserved
    // in place but stays sealed under whatever past key it was last
    // re-encrypted with, and the upcoming master.key write would discard
    // the OLD key forever, making those rows unrecoverable. Throwing here
    // rolls back the entire transaction (no rotation_state update, no
    // master.key file change) so the caller can take a snapshot, decide
    // whether the loss is acceptable, then re-call with
    // force_skip_damaged=true. Without this, a single rotation can
    // silently strand data (and a rotation loop can strand all of it).
    if (skipped > 0 && !opts?.force_skip_damaged) {
      throw new RotationDamagedRowsError(skipped);
    }

    // Store the full pending key-file set in rotation_state in the same
    // transaction as re-encryption. If crash: entire transaction rolls
    // back, old key + old data intact. If crash AFTER the transaction
    // commits but before commitKeyRotation writes the canonical files,
    // the Ledger constructor's recovery path reads pending_files_json and
    // replays the full file set durably (Codex round-1 P1 on PR #72), then
    // re-derives the master key via initializeMasterKey — so the raw key
    // never has to be persisted.
    //
    // M2: pending_key is left NULL. It used to hold the raw new master key
    // as a recovery source, but in passphrase mode that put the plaintext
    // key at rest in the DB, breaking the "key exists only in memory"
    // guarantee. It was redundant: pending_files_json holds the canonical
    // recovery material (master.salt + master.verify in passphrase mode;
    // the dev master.key in dev mode — same boundary as the on-disk file),
    // and durable replay + initializeMasterKey reproduce the new key
    // without it. The column stays only so a pre-PR#72 legacy row (raw
    // pending_key, no pending_files_json) can still be recovered on open.
    //
    // last_rotation_at is set in the same write so rate-limit state is
    // atomic with the rotation itself; a SIGKILL between this commit and
    // commitKeyRotation still leaves a recoverable rotation that will
    // replay on next boot, and last_rotation_at correctly reflects when
    // the rotation was initiated.
    this.db.prepare(
      "UPDATE rotation_state SET pending_key = NULL, pending_version = ?, pending_files_json = ?, last_rotation_at = datetime('now') WHERE id = 1"
    ).run(version, serializePendingKeyFiles(pendingFiles));
  });

  // Phase 2: Execute re-encryption + store new key in single atomic transaction.
  // If crash: transaction rolls back, old key + old data, nothing lost.
  transaction();

  // Phase 3: Write key files to disk. If crash here, on next startup
  // we detect pending_key in rotation_state and recover.
  commitKeyRotation(pendingFiles);

  // Phase 3.5: Caller hook for re-encrypting out-of-band data
  // (e.g. adapter config files at ~/.usrcp/<name>-config.json that
  // hold OAuth refresh tokens / bot tokens / API keys encrypted
  // under the global key derived from the master key). Without this,
  // every encrypted adapter config becomes unreadable after rotation.
  //
  // Both keys are still allocated. If the hook throws, log a warning
  // and continue: the master key has already rotated, we can't roll
  // back, but accumulating partial state is worse than reporting and
  // moving on. Callers that need per-item diagnostics should catch
  // internally.
  if (opts?.onKeysReady) {
    try {
      opts.onKeysReady(oldKey, newKey);
    } catch (err) {
      console.warn(
        `[usrcp] rotateKey: onKeysReady hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Phase 4: Clear pending state - rotation complete
  this.db.prepare(
    "UPDATE rotation_state SET pending_key = NULL, pending_version = NULL, pending_files_json = NULL WHERE id = 1"
  ).run();

  // Update in-memory key
  const oldMasterKey = this.masterKey;
  this.masterKey = newKey;
  zeroBuffer(oldMasterKey);

  // Reset tamper tracker
  const tracker = this.getTamperTracker();
  if (tracker.count > 0) {
    this.updatePreferences({ custom: { tamperTracker: { ...tracker, count: 0, lastTamper: null } } });
    this.logAudit("key_rotation_reset_tamper", undefined, undefined, `old_count=${tracker.count}`);
  }

  // Rebuild blind index with new key
  this.rebuildBlindIndex();

  this.logAudit("key_rotation", undefined, undefined, `version=${version}`);
  if (skipped > 0) {
    this.logAudit("key_rotation_skipped", undefined, undefined, `count=${skipped}`);
  }
  return { version, reencrypted, skipped };
};
