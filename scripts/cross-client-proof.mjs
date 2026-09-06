#!/usr/bin/env node
/**
 * Headless proof of the USRCP cross-editor claim.
 *
 * The pitch's central artifact is "the same structured user state across
 * two editors, with the server holding only ciphertext." Two editors
 * (Claude Desktop, Cursor) are, mechanically, just two MCP clients each
 * running `usrcp serve --stdio` against the same ~/.usrcp ledger. So this
 * script reproduces the exact claim WITHOUT any editor — to de-risk a live
 * recording (if this passes, the only thing that can go wrong on camera is
 * an editor's MCP wiring, not USRCP itself):
 *
 *   1. Client A (Claude Desktop persona): initialize → usrcp_update_identity
 *      + usrcp_append_event. Then disconnect.
 *   2. Client B (Cursor persona): a FRESH `usrcp serve` process →
 *      initialize → usrcp_get_state. Assert A's identity + event are
 *      visible. This is the cross-client read.
 *   3. Open the raw ledger.db with node:sqlite and assert the plaintext
 *      markers never appear in any column — the ciphertext-at-rest proof.
 *
 * Runs against an isolated HOME so it never touches a real ledger. Exit 0
 * = the demo's claim holds end-to-end.
 *
 * Usage:
 *   node scripts/cross-client-proof.mjs              # uses built dist + a fresh tmp HOME
 *   USRCP_ENTRY="/abs/dist/index.js" node scripts/cross-client-proof.mjs
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_PKG = path.join(REPO_ROOT, "packages", "usrcp-local");
const ENTRY = process.env.USRCP_ENTRY || path.join(LOCAL_PKG, "dist", "index.js");

const PASSPHRASE = "cross-client-demo-pass";
// Content markers: user-authored values written by editor A. Each must be
// (a) readable by editor B cross-client AND (b) absent from the raw DB —
// these are the encrypted content fields the zero-knowledge claim covers.
const MARKERS = {
  role: "kingpin", // distinctive so the substring scan can't false-positive
  expertise: "rescript", // a real but rare language token
  projectName: "Helios Memory Engine",
  eventSummary: "shipped the npm publish rail",
  projectSummary: "encrypted cross-editor memory protocol",
  projectId: "proj-demo-0xfeed",
};
// Include the original user-chosen project id in the plaintext scan.
const PROJECT_ID = "proj-demo-0xfeed";

function log(m) { process.stdout.write(`${m}\n`); }
function ok(m) { process.stdout.write(`\x1b[32m✓\x1b[0m ${m}\n`); }
function die(m) { process.stderr.write(`\x1b[31m✗ ${m}\x1b[0m\n`); process.exit(1); }

if (!fs.existsSync(ENTRY)) {
  die(`built CLI not found at ${ENTRY}. Run: (cd packages/usrcp-local && npm run build)`);
}

const proofHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-xclient-"));

/**
 * Drive one `usrcp serve --stdio` session: initialize, then run each
 * {name, args} tool call in order. Returns the array of tool results
 * (parsed JSON of the first text content block). One process per call to
 * `runSession` — modelling a distinct editor connecting.
 */
function runSession(calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, "serve", "--stdio"], {
      env: { ...process.env, HOME: proofHome, USRCP_PASSPHRASE: PASSPHRASE },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", reject);

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const results = [];
    let nextId = 2;
    const pending = [];

    function pump() {
      let idx;
      while ((idx = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, idx).replace(/\r$/, "");
        stdout = stdout.slice(idx + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id !== undefined) pending.push(frame);
      }
    }

    async function waitFor(id, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        pump();
        const hit = pending.find((f) => f.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timeout waiting for id=${id}; stderr=${stderr}`);
    }

    (async () => {
      try {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "xclient-proof", version: "0.0.0" } } });
        const init = await waitFor(1);
        if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

        for (const call of calls) {
          const id = nextId++;
          send({ jsonrpc: "2.0", id, method: "tools/call",
            params: { name: call.name, arguments: call.args } });
          const res = await waitFor(id);
          if (res.error) throw new Error(`${call.name}: ${JSON.stringify(res.error)}`);
          const text = res.result?.content?.[0]?.text ?? "{}";
          if (res.result?.isError) throw new Error(`${call.name}: ${text}`);
          results.push(call.name === "usrcp_handoff" ? text : JSON.parse(text));
        }
        child.kill("SIGTERM");
        resolve(results);
      } catch (e) {
        child.kill("SIGKILL");
        reject(e);
      }
    })();
  });
}

try {
  // ── Bootstrap: init a passphrase ledger in the isolated HOME ──────────
  execFileSync(process.execPath, [ENTRY, "init", "--passphrase", PASSPHRASE], {
    env: { ...process.env, HOME: proofHome }, stdio: "ignore",
  });
  ok(`isolated ledger initialized at ${proofHome}/.usrcp`);

  // ── Editor A (Claude Desktop persona): WRITE identity + event ─────────
  log("\n── Editor A (Claude Desktop) writes user state ──");
  await runSession([
    { name: "usrcp_update_identity", args: {
      display_name: "Demo Founder",
      roles: [MARKERS.role],
      expertise_domains: [{ domain: MARKERS.expertise, level: "expert" }],
    } },
    { name: "usrcp_append_event", args: {
      domain: "coding", summary: MARKERS.eventSummary, intent: "ship the rail",
      outcome: "success", platform: "claude_desktop",
    } },
    { name: "usrcp_manage_project", args: {
      project_id: PROJECT_ID, name: MARKERS.projectName, domain: "coding",
      status: "active", summary: MARKERS.projectSummary,
    } },
  ]);
  ok("Editor A wrote identity, an event, and a project");

  // ── Editor B (Cursor persona): READ it back, fresh process ────────────
  log("\n── Editor B (Cursor) reads the same ledger ──");
  const [state] = await runSession([
    { name: "usrcp_get_state", args: { scopes: [
      "core_identity", "global_preferences", "active_projects", "recent_timeline",
    ] } },
  ]);
  const blob = JSON.stringify(state).toLowerCase();
  for (const [k, v] of Object.entries(MARKERS)) {
    if (!blob.includes(v.toLowerCase())) {
      die(`cross-client read FAILED: marker "${k}"="${v}" not visible to Editor B`);
    }
  }
  ok("Editor B sees A's identity, event, and project — cross-editor state confirmed");

  const [brief] = await runSession([{ name: "usrcp_handoff", args: { domain: "coding", max_chars: 6000 } }]);
  if (!brief.startsWith("# User context handoff") || !brief.includes(MARKERS.eventSummary)) throw new Error("Fresh client did not receive the latest Markdown brief");
  const markdown = execFileSync(process.execPath, [ENTRY, "handoff", "--domain=coding"], { env: { ...process.env, HOME: proofHome, USRCP_PASSPHRASE: PASSPHRASE }, encoding: "utf8" });
  if (!markdown.includes(MARKERS.eventSummary)) throw new Error("CLI Markdown handoff omitted recent work");
  ok("Fresh MCP client and CLI export both receive the latest condensed Markdown brief");

  // ── Ciphertext-at-rest: raw DB must NOT contain the plaintext ─────────
  log("\n── Server-sees-only-ciphertext proof (raw SQLite scan) ──");
  const require = createRequire(path.join(LOCAL_PKG, "package.json"));
  const { DatabaseSync: Database } = require("node:sqlite");
  const dbPath = path.join(proofHome, ".usrcp", "users", "default", "ledger.db");
  const db = new Database(dbPath, { readOnly: true });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  let scannedCells = 0;
  const leaks = [];
  for (const t of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { continue; }
    for (const row of rows) {
      for (const val of Object.values(row)) {
        if (typeof val !== "string") continue;
        scannedCells++;
        const low = val.toLowerCase();
        for (const [k, v] of Object.entries(MARKERS)) {
          if (low.includes(v.toLowerCase())) leaks.push(`${t}: "${v}" (${k})`);
        }
      }
    }
  }
  db.close();
  if (leaks.length) {
    die(`CONTENT PLAINTEXT LEAK in ledger.db:\n  ${leaks.join("\n  ")}`);
  }
  ok(`scanned ${scannedCells} string cells across ${tables.length} tables — zero content markers in plaintext`);


  log("\n\x1b[1;32m━━━ cross-editor claim VERIFIED end-to-end ━━━\x1b[0m");
  log("Two independent MCP processes share state and Markdown handoffs; tested content markers are absent from raw ledger cells.");
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
} finally {
  fs.rmSync(proofHome, { recursive: true, force: true });
}
