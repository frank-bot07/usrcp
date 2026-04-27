/**
 * service-worker.ts — MV3 service worker for the USRCP extension
 *
 * Responsibilities:
 *   1. Own the Native Messaging port to usrcp-bridge.js.
 *   2. Send a heartbeat ping every 20s to keep the SW alive while the NM port
 *      is open. Without this, Chrome terminates idle SWs after ~30s.
 *   3. Route incoming messages from content scripts:
 *      - ledger.append → forward turn to bridge for ledger storage
 *      - memory.search → forward query to bridge, relay results back to content
 *   4. Fan out bridge responses to waiting content-script callers.
 *
 * Architecture:
 *   content-claude.ts → chrome.runtime.sendMessage → SW
 *   SW → chrome.runtime.connectNative("com.usrcp.bridge") → usrcp-bridge.js
 *   usrcp-bridge.js → usrcp-local Ledger (direct import, no MCP server)
 *   usrcp-bridge.js → SW → chrome.tabs.sendMessage → content-claude.ts
 */

import type {
  SwMessage,
  BridgeOp,
  BridgeResponse,
  BridgeSearchResponse,
  SwSearchResult,
} from "./shared/types.js";

// ---------------------------------------------------------------------------
// Native Messaging port lifecycle
// ---------------------------------------------------------------------------

const NM_HOST = "com.usrcp.bridge";
const HEARTBEAT_INTERVAL_MS = 20_000;

let port: ReturnType<typeof chrome.runtime.connectNative> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// requestId → sender tabId for routing search results back
const pendingSearches = new Map<string, number>();

function connectNative(): void {
  if (port) return; // already connected

  try {
    port = chrome.runtime.connectNative(NM_HOST);
  } catch (err) {
    console.error("[usrcp-sw] Failed to connect native host:", err);
    port = null;
    return;
  }

  port.onMessage.addListener((msg: unknown) => {
    handleBridgeMessage(msg as BridgeResponse);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn("[usrcp-sw] NM port disconnected:", err.message);
    }
    port = null;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });

  // Start heartbeat
  heartbeatTimer = setInterval(() => {
    if (port) {
      const ping: BridgeOp = { op: "ping" };
      port.postMessage(ping);
    } else {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function postToBridge(msg: BridgeOp): void {
  if (!port) {
    connectNative();
  }
  if (port) {
    port.postMessage(msg);
  } else {
    console.error("[usrcp-sw] No NM port; dropping message:", msg.op);
  }
}

// ---------------------------------------------------------------------------
// Bridge → content routing
// ---------------------------------------------------------------------------

function handleBridgeMessage(msg: BridgeResponse): void {
  if (msg.op === "pong") {
    // Heartbeat ack — nothing to do
    return;
  }

  if (msg.op === "memory.search.result") {
    const searchMsg = msg as BridgeSearchResponse;
    const tabId = pendingSearches.get(searchMsg.requestId);
    if (tabId === undefined) return;
    pendingSearches.delete(searchMsg.requestId);

    const result: SwSearchResult = {
      kind: "memory.search.result",
      requestId: searchMsg.requestId,
      snippets: searchMsg.snippets,
      error: searchMsg.error,
    };

    chrome.tabs.sendMessage(tabId, result).catch((err: unknown) => {
      console.debug("[usrcp-sw] Failed to relay search result to tab:", err);
    });
  }
}

// ---------------------------------------------------------------------------
// Content-script message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    _sendResponse: (response?: unknown) => void
  ): boolean | void => {
    const msg = message as SwMessage;
    if (!msg || !msg.kind) return;

    switch (msg.kind) {
      case "ledger.append": {
        const op: BridgeOp = { op: "ledger.append", turn: msg.turn };
        postToBridge(op);
        break;
      }

      case "memory.search": {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          console.warn("[usrcp-sw] memory.search from non-tab sender; ignoring");
          break;
        }
        pendingSearches.set(msg.requestId, tabId);
        const op: BridgeOp = {
          op: "memory.search",
          q: msg.q,
          limit: 5,
          requestId: msg.requestId,
        };
        postToBridge(op);
        break;
      }

      case "ping":
        break; // no-op

      default:
        break;
    }
  }
);

// ---------------------------------------------------------------------------
// Connect on install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  connectNative();
});

// Attempt connection when SW starts (e.g., after Chrome restart)
connectNative();
