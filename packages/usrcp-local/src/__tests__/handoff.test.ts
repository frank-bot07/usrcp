import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildHandoff, renderHandoff } from "../handoff.js";
import { pilotStatus, setPilotConsent, recordHandoff } from "../pilot.js";
const { Ledger } = createRequire(import.meta.url)("usrcp-core/ledger");
let home: string; let original: string | undefined; let ledger: InstanceType<typeof Ledger>;
beforeEach(() => { original = process.env.HOME; home = mkdtempSync(join(tmpdir(), "usrcp-handoff-")); process.env.HOME = home; ledger = new Ledger(); });
afterEach(() => { ledger.close(); process.env.HOME = original; rmSync(home, { recursive: true, force: true }); });
describe("condensed handoff", () => {
  it("excludes other domains and rejected or expired facts; bounds output", () => {
    ledger.setFact("coding", "stack", "approved", "typescript", { review: { source: "owner", status: "approved" } });
    ledger.setFact("coding", "stack", "rejected", "WRONG", { review: { source: "owner", status: "rejected" } });
    ledger.setFact("coding", "stack", "expired", "OLD", { review: { source: "owner", status: "approved", expires_at: "2000-01-01" } });
    ledger.setFact("health", "private", "secret", "PRIVATE");
    ledger.appendEvent({ domain: "coding", summary: "Next: finish login", intent: "continue", outcome: "in_progress" }, "test");
    const packet = buildHandoff(ledger, "coding", 1000);
    const text = renderHandoff(packet);
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(1000);
    expect(text).toContain("typescript");
    expect(text).not.toMatch(/WRONG|OLD|PRIVATE/);
    expect(text).toContain("# User context handoff");
  });
  it("stores review provenance encrypted and resets approval when an agent changes a fact", () => {
    ledger.setFact("coding", "stack", "language", "typescript", { review: { source: "PRIVATE-SOURCE", status: "approved", confirmed_at: "2026-09-06" } });
    expect(ledger.getFact("coding", "stack", "language").review.status).toBe("approved");
    const row = ledger.db.prepare("SELECT review_enc FROM schemaless_facts").get();
    expect(row.review_enc).not.toContain("PRIVATE-SOURCE");
    ledger.rotateKey();
    expect(ledger.getFact("coding", "stack", "language").review.source).toBe("PRIVATE-SOURCE");
    ledger.setFact("coding", "stack", "language", "python", { agentId: "agent" });
    expect(ledger.getFact("coding", "stack", "language").review.status).toBe("unreviewed");
  });
  it("keeps pilot metrics opt-in, content-free and clearable", () => {
    recordHandoff("codex"); expect(pilotStatus().enabled).toBe(false);
    expect(existsSync(join(home, ".usrcp/users/default/pilot-metrics.json"))).toBe(false);
    setPilotConsent(true); recordHandoff("private-user-content");
    const raw = readFileSync(join(home, ".usrcp/users/default/pilot-metrics.json"), "utf8");
    expect(raw).not.toContain("private-user-content"); expect(raw).toContain("other");
    setPilotConsent(false); expect(pilotStatus().days).toEqual({});
  });
});
