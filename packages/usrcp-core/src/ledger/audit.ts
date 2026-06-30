import * as crypto from "node:crypto";
import { Ledger } from "./core.js";
import { deriveGlobalEncryptionKey, zeroBuffer } from "../encryption.js";

declare module "./core.js" {
  interface Ledger {
    logAudit(
      operation: string,
      scopesOrDomain?: string | string[],
      eventIds?: string[],
      detail?: string,
      responseSize?: number,
      agentId?: string
    ): void;
    getAuditLog(limit?: number): any[];
  }
}

Ledger.prototype.logAudit = function (
  this: Ledger,
  operation: string,
  scopesOrDomain?: string | string[],
  eventIds?: string[],
  detail?: string,
  responseSize?: number,
  agentId: string = "system"
): void {
  const scopes = Array.isArray(scopesOrDomain)
    ? scopesOrDomain.join(",")
    : scopesOrDomain || null;

  // Build the audit entry
  const encAgentId = this.encryptGlobal(agentId);
  const encOperation = this.encryptGlobal(operation);
  const encScopes = scopes ? this.encryptGlobal(scopes) : null;
  const encEventIds = eventIds ? this.encryptGlobal(JSON.stringify(eventIds)) : null;
  const encDetail = detail ? this.encryptGlobal(detail) : null;

  // HMAC integrity tag — proves the audit entry was written by this ledger
  // and has not been tampered with. Covers all encrypted fields.
  const integrityPayload = [encAgentId, encOperation, encScopes || "", encEventIds || "", encDetail || ""].join("|");
  const globalKey = deriveGlobalEncryptionKey(this.masterKey);
  const integrityTag = crypto.createHmac("sha256", globalKey).update(integrityPayload).digest("hex").slice(0, 32);
  zeroBuffer(globalKey);

  this.db
    .prepare(
      `INSERT INTO audit_log (agent_id, operation, scopes_accessed, event_ids, detail, response_size_bytes, integrity_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(encAgentId, encOperation, encScopes, encEventIds, encDetail, responseSize || 0, integrityTag);
};

Ledger.prototype.getAuditLog = function (
  this: Ledger,
  limit: number = 100
): any[] {
  const rows = this.db
    .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as any[];

  const globalKey = deriveGlobalEncryptionKey(this.masterKey);

  const results = rows.map((row) => {
    let entryTampered = false;
    let verified = true;

    if (row.integrity_tag) {
      try {
        const payload = [
          row.agent_id, row.operation,
          row.scopes_accessed || "", row.event_ids || "", row.detail || "",
        ].join("|");
        const expected = crypto.createHmac("sha256", globalKey).update(payload).digest("hex").slice(0, 32);
        const tagBuf = Buffer.from(row.integrity_tag);
        const expectedBuf = Buffer.from(expected);
        if (tagBuf.length === expectedBuf.length) {
          verified = crypto.timingSafeEqual(tagBuf, expectedBuf);
        } else {
          verified = false;
        }
        if (!verified) {
          this.handleTamper('audit', `integrity_${row.id}`);
          entryTampered = true;
        }
      } catch {
        verified = false;
        this.handleTamper('audit', `integrity_error_${row.id}`);
        entryTampered = true;
      }
    }

    const agentRes = this.safeDecryptGlobal(row.agent_id || "", '', 'agent_id');
    entryTampered ||= agentRes.tampered;
    const opRes = this.safeDecryptGlobal(row.operation || "", '', 'operation');
    entryTampered ||= opRes.tampered;
    const scopesRes = row.scopes_accessed ? this.safeDecryptGlobal(row.scopes_accessed, '', 'scopes_accessed') : {value: null as any, tampered: false};
    entryTampered ||= scopesRes.tampered;
    const eventsRes = row.event_ids ? this.safeDecryptGlobal(row.event_ids, '', 'event_ids') : {value: null as any, tampered: false};
    entryTampered ||= eventsRes.tampered;
    const detailRes = row.detail ? this.safeDecryptGlobal(row.detail, '', 'detail') : {value: null as any, tampered: false};
    entryTampered ||= detailRes.tampered;

    return {
      id: row.id,
      timestamp: row.timestamp,
      agent_id: agentRes.value,
      operation: opRes.value,
      scopes_accessed: scopesRes.value || null,
      event_ids: eventsRes.value || null,
      detail: detailRes.value || null,
      response_size_bytes: row.response_size_bytes,
      integrity_verified: verified,
      tampered: entryTampered,
    };
  });

  zeroBuffer(globalKey);

  return results;
};
