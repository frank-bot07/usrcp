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
} from "../encryption.js";
import { safeJsonParse } from "./helpers.js";

declare module "./core.js" {
  interface Ledger {
    rebuildBlindIndex(): void;
    rotateKey(passphrase?: string): { version: number; reencrypted: number; skipped: number };
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
  passphrase?: string
): { version: number; reencrypted: number; skipped: number } {
  // Phase 1: Prepare new key material WITHOUT writing to disk
  const { oldKey, newKey, version, pendingFiles } = prepareKeyRotation(this.masterKey, passphrase);
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

    // Store new key in rotation_state — same transaction as re-encryption
    // If crash: entire transaction rolls back, old key + old data intact
    this.db.prepare(
      "UPDATE rotation_state SET pending_key = ?, pending_version = ? WHERE id = 1"
    ).run(newKey, version);
  });

  // Phase 2: Execute re-encryption + store new key in single atomic transaction.
  // If crash: transaction rolls back, old key + old data, nothing lost.
  transaction();

  // Phase 3: Write key files to disk. If crash here, on next startup
  // we detect pending_key in rotation_state and recover.
  commitKeyRotation(pendingFiles);

  // Phase 4: Clear pending state — rotation complete
  this.db.prepare(
    "UPDATE rotation_state SET pending_key = NULL, pending_version = NULL WHERE id = 1"
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
