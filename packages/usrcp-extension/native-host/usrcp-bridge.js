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
const { Ledger } = require(path.join(__dirname, "..", "node_modules", "usrcp-local", "dist", "ledger", "index.js"));

// ---------------------------------------------------------------------------
// Ledger initialization
// ---------------------------------------------------------------------------

let ledger = null;

function getLedger() {
  if (ledger) return ledger;
  try {
    const passphrase = process.env.USRCP_PASSPHRASE || undefined;
    ledger = new Ledger(undefined, passphrase);
    return ledger;
  } catch (err) {
    throw new Error(`Failed to open USRCP ledger: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Chrome NM framing
// ---------------------------------------------------------------------------

/** Read one NM message from stdin. Returns a Buffer or null on EOF. */
function readNMMessage() {
  return new Promise((resolve, reject) => {
    const lenBuf = Buffer.alloc(4);
    let lenRead = 0;

    function readLength() {
      process.stdin.once("readable", () => {
        const chunk = process.stdin.read(4 - lenRead);
        if (!chunk) {
          // EOF
          resolve(null);
          return;
        }
        chunk.copy(lenBuf, lenRead);
        lenRead += chunk.length;
        if (lenRead < 4) {
          readLength();
        } else {
          const msgLen = lenBuf.readUInt32LE(0);
          readBody(msgLen);
        }
      });
    }

    function readBody(len) {
      let bodyBuf = Buffer.alloc(0);
      function tryRead() {
        process.stdin.once("readable", () => {
          const chunk = process.stdin.read(len - bodyBuf.length);
          if (!chunk) {
            // EOF before full message
            resolve(null);
            return;
          }
          bodyBuf = Buffer.concat([bodyBuf, chunk]);
          if (bodyBuf.length < len) {
            tryRead();
          } else {
            resolve(bodyBuf);
          }
        });
      }
      tryRead();
    }

    process.stdin.on("error", reject);
    readLength();
  });
}

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
      try {
        const db = getLedger();
        const events = db.searchTimeline(q, { limit: Math.min(limit, 10) });
        const snippets = events.map((ev) => {
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
  while (true) {
    const buf = await readNMMessage();
    if (!buf) {
      // EOF — Chrome closed the connection
      break;
    }
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch (err) {
      writeNMMessage({ op: "error", error: `JSON parse error: ${err.message}` });
      continue;
    }
    await handleMessage(msg);
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
