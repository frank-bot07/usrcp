import * as crypto from "node:crypto";
import { Ledger } from "./core.js";
import type { SchemaFact } from "../types.js";
import { deriveBlindIndexKey, zeroBuffer } from "../encryption.js";
import { safeJsonParse, generateULID } from "./helpers.js";

declare module "./core.js" {
  interface Ledger {
    setFact(
      domain: string,
      namespace: string,
      key: string,
      value: unknown,
      opts?: { expectedVersion?: number; agentId?: string }
    ): { fact_id: string; created: boolean; updated_at: string; version: number };
    getFact(domain: string, namespace: string, key: string): SchemaFact | null;
    listFacts(domain: string, namespace?: string): SchemaFact[];
    deleteFact(factId: string, agentId?: string): boolean;
  }
}

/**
 * Deterministic HMAC of (namespace, key) under the domain's blind-index
 * key. Used as the lookup column for schemaless_facts. Domain-scoped so
 * the same (namespace, key) under a different domain maps to a different
 * hash.
 * @internal
 */
function factLookupHash(ledger: Ledger, domain: string, namespace: string, key: string): string {
  const blindKey = deriveBlindIndexKey(ledger.masterKey, domain);
  const h = crypto.createHmac("sha256", blindKey);
  // Length-prefix to avoid (ns="a", k="bb") colliding with (ns="ab", k="b")
  h.update(`${namespace.length}:${namespace}|${key.length}:${key}`);
  const tag = h.digest("hex");
  zeroBuffer(blindKey);
  return tag;
}

/** @internal */
function validateFactInput(namespace: string, key: string, valueSerialized: string): void {
  if (namespace.length === 0) throw new Error("namespace cannot be empty");
  if (key.length === 0) throw new Error("key cannot be empty");
  if (namespace.length > Ledger.MAX_FACT_NAMESPACE)
    throw new Error(`namespace exceeds ${Ledger.MAX_FACT_NAMESPACE} chars`);
  if (key.length > Ledger.MAX_FACT_KEY)
    throw new Error(`key exceeds ${Ledger.MAX_FACT_KEY} chars`);
  if (Buffer.byteLength(valueSerialized, "utf8") > Ledger.MAX_FACT_VALUE_BYTES)
    throw new Error(`value exceeds ${Ledger.MAX_FACT_VALUE_BYTES} bytes`);
}

/** @internal */
function rowToFact(ledger: Ledger, row: any): SchemaFact {
  const realDomain = ledger.resolveDomain(row.domain);
  const namespace = ledger.decryptForDomain(row.namespace, realDomain);
  const key = ledger.decryptForDomain(row.key, realDomain);
  const valueRaw = ledger.decryptForDomain(row.value, realDomain);
  return {
    fact_id: row.fact_id,
    domain: realDomain,
    namespace,
    key,
    value: safeJsonParse<unknown>(valueRaw, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version ?? 1,
  };
}

Ledger.prototype.setFact = function (
  this: Ledger,
  domain: string,
  namespace: string,
  key: string,
  value: unknown,
  opts: { expectedVersion?: number; agentId?: string } = {}
): { fact_id: string; created: boolean; updated_at: string; version: number } {
  const agentId = opts.agentId ?? "system";
  const valueSerialized = JSON.stringify(value ?? null);
  validateFactInput(namespace, key, valueSerialized);

  const domainPseudo = this.ensureDomainMapping(domain);
  const nsKeyHash = factLookupHash(this, domain, namespace, key);

  const existing = this.db
    .prepare(
      "SELECT fact_id, version FROM schemaless_facts WHERE domain = ? AND ns_key_hash = ?"
    )
    .get(domainPseudo, nsKeyHash) as { fact_id: string; version: number } | undefined;

  this.checkExpectedVersion(
    "schemaless_facts",
    existing?.version ?? 0,
    opts.expectedVersion,
    `${domain}/${namespace}/${key}`
  );

  const namespaceEnc = this.encryptForDomain(namespace, domain);
  const keyEnc = this.encryptForDomain(key, domain);
  const valueEnc = this.encryptForDomain(valueSerialized, domain);

  if (existing) {
    const newVersion = existing.version + 1;
    this.db
      .prepare(
        `UPDATE schemaless_facts
        SET namespace = ?, "key" = ?, value = ?, version = ?, updated_at = datetime('now')
        WHERE fact_id = ?`
      )
      .run(namespaceEnc, keyEnc, valueEnc, newVersion, existing.fact_id);
    const updated = this.db
      .prepare("SELECT updated_at FROM schemaless_facts WHERE fact_id = ?")
      .get(existing.fact_id) as { updated_at: string };
    this.logAudit("set_fact", domainPseudo, [existing.fact_id], undefined, undefined, agentId);
    return { fact_id: existing.fact_id, created: false, updated_at: updated.updated_at, version: newVersion };
  }

  const factId = generateULID();
  this.db
    .prepare(
      `INSERT INTO schemaless_facts (fact_id, domain, ns_key_hash, namespace, "key", value, version)
      VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(factId, domainPseudo, nsKeyHash, namespaceEnc, keyEnc, valueEnc);
  const created = this.db
    .prepare("SELECT created_at FROM schemaless_facts WHERE fact_id = ?")
    .get(factId) as { created_at: string };
  this.logAudit("set_fact", domainPseudo, [factId], undefined, undefined, agentId);
  return { fact_id: factId, created: true, updated_at: created.created_at, version: 1 };
};

Ledger.prototype.getFact = function (
  this: Ledger,
  domain: string,
  namespace: string,
  key: string
): SchemaFact | null {
  const domainPseudo = this.domainPseudonym(domain);
  const nsKeyHash = factLookupHash(this, domain, namespace, key);
  const row = this.db
    .prepare(
      "SELECT * FROM schemaless_facts WHERE domain = ? AND ns_key_hash = ?"
    )
    .get(domainPseudo, nsKeyHash) as any;
  if (!row) return null;
  return rowToFact(this, row);
};

Ledger.prototype.listFacts = function (
  this: Ledger,
  domain: string,
  namespace?: string
): SchemaFact[] {
  const domainPseudo = this.domainPseudonym(domain);
  const rows = this.db
    .prepare(
      "SELECT * FROM schemaless_facts WHERE domain = ? ORDER BY updated_at DESC"
    )
    .all(domainPseudo) as any[];
  if (namespace === undefined) {
    return rows.map((r) => rowToFact(this, r));
  }
  // Namespace filter: decrypt namespace first and skip non-matches before
  // paying to decrypt the other two columns. Saves ~2/3 of the GCM work
  // when most rows don't match the filter.
  const realDomain = this.resolveDomain(domainPseudo);
  const matches: SchemaFact[] = [];
  for (const r of rows) {
    const ns = this.decryptForDomain(r.namespace, realDomain);
    if (ns !== namespace) continue;
    matches.push(rowToFact(this, r));
  }
  return matches;
};

Ledger.prototype.deleteFact = function (
  this: Ledger,
  factId: string,
  agentId: string = "system"
): boolean {
  const row = this.db
    .prepare("SELECT domain FROM schemaless_facts WHERE fact_id = ?")
    .get(factId) as { domain: string } | undefined;
  if (!row) return false;
  const result = this.db
    .prepare("DELETE FROM schemaless_facts WHERE fact_id = ?")
    .run(factId);
  this.logAudit("delete_fact", row.domain, [factId], undefined, undefined, agentId);
  return result.changes > 0;
};
