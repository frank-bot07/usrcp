import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDir, safeWriteFile } from "usrcp-core/encryption";
interface PilotData { enabled: boolean; days: Record<string, { handoffs: number; clients: string[] }> }
const file = () => path.join(getUserDir(), "pilot-metrics.json");
export function pilotStatus(): PilotData {
  if (!fs.existsSync(file())) return { enabled: false, days: {} };
  return JSON.parse(fs.readFileSync(file(), "utf8")) as PilotData;
}
export function setPilotConsent(enabled: boolean): PilotData {
  const data = enabled ? { ...pilotStatus(), enabled } : { enabled: false, days: {} };
  safeWriteFile(file(), Buffer.from(JSON.stringify(data)), 0o600); return data;
}
export function recordHandoff(client: string, now = new Date()): void {
  // Metrics are optional and cannot make context unavailable if their file fails.
  try {
    const data = pilotStatus(); if (!data.enabled) return;
    const name = ["claude-code", "codex", "cursor"].includes(client) ? client : "other";
    const day = now.toISOString().slice(0, 10);
    const entry = data.days[day] ?? { handoffs: 0, clients: [] };
    entry.handoffs++; if (!entry.clients.includes(name)) entry.clients.push(name);
    data.days[day] = entry;
    const floor = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
    for (const key of Object.keys(data.days)) if (key < floor) delete data.days[key];
    safeWriteFile(file(), Buffer.from(JSON.stringify(data)), 0o600);
  } catch { /* No raw content or identifiers in diagnostics. */ }
}
