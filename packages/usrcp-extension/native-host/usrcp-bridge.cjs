#!/usr/bin/env node
/**
 * usrcp-bridge.js — Native Messaging host for the USRCP browser extension.
 *
 * Architecture decision (v0):
 * Rather than spawning a full MCP server or connecting to a daemon over TCP,
 * this bridge imports usrcp-local directly and calls Ledger methods in-process.
 * This is the simplest path to working v0: no "start the daemon first" friction,
 * no port negotiation, no passphrase IPC problem (the bridge runs as the user
 * and inherits USRCP_PASSPHRASE from the environment if set — Chrome NM hosts
 * inherit the user's launchd/systemd environment on macOS/Linux).
 *
 * Tradeoff: the bridge initializes a Ledger instance on each invocation
 * (Chrome starts a fresh native host per connectNative). SQLite WAL mode handles
 * concurrent readers fine; writes from the extension don't conflict with the
 * CLI since both use the same DB path with proper locking.
 *
 * Message framing (Chrome NM spec):
 *   stdin:  [4-byte LE uint32 length][JSON payload]
 *   stdout: [4-byte LE uint32 length][JSON payload]
 *
 * Supported ops:
 *   { op: "ping" }
 *     → { op: "pong" }
 *
 *   { op: "ledger.append", turn: CapturedTurn }
 *     → { op: "ledger.append.result", ok: true, event_id: "..." }
 *     → { op: "ledger.append.result", ok: false, error: "..." }
 *
 *   { op: "memory.search", q: "...", limit: 5, requestId: "..." }
 *     → { op: "memory.search.result", requestId: "...", snippets: [...] }
 *     → { op: "memory.search.result", requestId: "...", snippets: [], error: "..." }
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Ledger initialization
// ---------------------------------------------------------------------------

let ledger = null;

function loadLedger() {
  const candidates = [
    path.join(__dirname, "..", "node_modules", "usrcp-local", "dist", "ledger", "index.js"),
    path.join(__dirname, "..", "..", "usrcp-local", "dist", "ledger", "index.js"),
  ];
  const ledgerPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!ledgerPath) {
    throw new Error("Could not locate usrcp-local ledger module. Reinstall usrcp-extension or build usrcp-local.");
  }
  return require(ledgerPath).Ledger;
}

function getLedger() {
  if (ledger) return ledger;
  try {
    const passphrase = process.env.USRCP_PASSPHRASE || undefined;
    const Ledger = loadLedger();
    ledger = new Ledger(undefined, passphrase);
    return ledger;
  } catch (err) {
    throw new Error(`Failed to open USRCP ledger: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Chrome NM framing
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Write one NM message to stdout. */
function writeNMMessage(obj) {
  const json = JSON.stringify(obj);
  const jsonBuf = Buffer.from(json, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);
  process.stdout.write(Buffer.concat([lenBuf, jsonBuf]));
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  if (!msg || typeof msg.op !== "string") {
    writeNMMessage({ op: "error", error: "Invalid message: missing op" });
    return;
  }

  switch (msg.op) {
    case "ping":
      writeNMMessage({ op: "pong" });
      break;

    case "ledger.append": {
      const turn = msg.turn;
      if (!turn || typeof turn.content !== "string") {
        writeNMMessage({ op: "ledger.append.result", ok: false, error: "Invalid turn payload" });
        break;
      }
      try {
        const db = getLedger();
        const summary = turn.content.slice(0, 200) + (turn.content.length > 200 ? "…" : "");
        const result = db.appendEvent(
          {
            domain: "claude.ai",
            summary,
            intent: "Capture Claude conversation turn",
            outcome: "success",
            detail: {
              conversation_id: turn.conversation_id,
              message_id: turn.id,
              full_content: turn.content,
            },
            tags: ["browser-extension", "claude.ai"],
          },
          "browser-extension",
          /* idempotencyKey */ turn.id
        );
        writeNMMessage({ op: "ledger.append.result", ok: true, event_id: result.event_id });
      } catch (err) {
        writeNMMessage({ op: "ledger.append.result", ok: false, error: err.message });
      }
      break;
    }

    case "memory.search": {
      const { q, limit = 5, requestId } = msg;
      if (!q || typeof q !== "string") {
        writeNMMessage({
          op: "memory.search.result",
          requestId: requestId ?? "",
          snippets: [],
          error: "Invalid query",
        });
        break;
      }

      // SECURITY (v0.1.3): scope to the user's configured allowed_domains.
      // If empty (legacy v0.1.2 config OR a fresh install that didn't pick
      // any domains in setup), refuse the search rather than returning the
      // full ledger. Defense-in-depth against page-JS-driven exfil.
      const os = require("node:os");
      const fs = require("node:fs");
      let allowedDomains = [];
      try {
        const cfgPath = path.join(os.homedir(), ".usrcp", "extension-config.json");
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          allowedDomains = Array.isArray(cfg.allowed_domains) ? cfg.allowed_domains : [];
        }
      } catch {
        allowedDomains = [];
      }
      if (allowedDomains.length === 0) {
        writeNMMessage({
          op: "memory.search.result",
          requestId: requestId ?? "",
          snippets: [],
          error: "Extension not authorized for any domain. Run 'usrcp setup --adapter=extension' to configure allowed_domains.",
        });
        break;
      }

      try {
        const db = getLedger();
        // searchTimeline takes a single domain filter, so search each
        // allowed domain in turn and merge / dedupe.
        const cap = Math.min(limit, 10);
        const merged = [];
        const seenIds = new Set();
        for (const domain of allowedDomains) {
          const events = db.searchTimeline(q, { limit: cap, domain });
          for (const ev of events) {
            if (seenIds.has(ev.event_id)) continue;
            seenIds.add(ev.event_id);
            merged.push(ev);
          }
        }
        merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const snippets = merged.slice(0, cap).map((ev) => {
          const ts = new Date(ev.timestamp).toLocaleDateString();
          return `[${ts}] ${ev.summary}`;
        });
        writeNMMessage({
          op: "memory.search.result",
          requestId: requestId ?? "",
          snippets,
        });
      } catch (err) {
        writeNMMessage({
          op: "memory.search.result",
          requestId: requestId ?? "",
          snippets: [],
          error: err.message,
        });
      }
      break;
    }

    default:
      writeNMMessage({ op: "error", error: `Unknown op: ${msg.op}` });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

process.stdin.resume();

async function main() {
  let pending = Buffer.alloc(0);

  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);

    while (pending.length >= 4) {
      const msgLen = pending.readUInt32LE(0);
      if (msgLen > MAX_MESSAGE_BYTES) {
        throw new Error(`Native message exceeds ${MAX_MESSAGE_BYTES} byte limit`);
      }
      if (pending.length < 4 + msgLen) break;

      const buf = pending.subarray(4, 4 + msgLen);
      pending = pending.subarray(4 + msgLen);

      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch (err) {
        writeNMMessage({ op: "error", error: `JSON parse error: ${err.message}` });
        continue;
      }
      await handleMessage(msg);
    }
  }

  if (pending.length !== 0) {
    throw new Error("Incomplete native message at EOF");
  }

  if (ledger) {
    try { ledger.close(); } catch { /* ignore */ }
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[usrcp-bridge] Fatal: ${err.message}\n`);
  process.exit(1);
});
