/**
 * Message shapes for communication between:
 *   page-hook (MAIN world) → content-claude (isolated world) → service-worker
 *
 * All postMessage payloads from page-hook carry `source: "usrcp"` so content
 * scripts can filter out unrelated messages in the window.message stream.
 */

/** A captured assistant turn from the claude.ai completion SSE stream. */
export interface CapturedTurn {
  id: string;
  role: "assistant";
  content: string;
  conversation_id: string;
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Page → content (via window.postMessage)
// ---------------------------------------------------------------------------

export interface PageHookTurnMessage {
  source: "usrcp";
  kind: "turn";
  turn: CapturedTurn;
}

export type PageHookMessage = PageHookTurnMessage;

// ---------------------------------------------------------------------------
// Content → service-worker (via chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export interface SwAppendMessage {
  kind: "ledger.append";
  turn: CapturedTurn;
}

export interface SwSearchMessage {
  kind: "memory.search";
  q: string;
  requestId: string;
}

export interface SwPingMessage {
  kind: "ping";
}

export type SwMessage = SwAppendMessage | SwSearchMessage | SwPingMessage;

// ---------------------------------------------------------------------------
// Service-worker → content (search results, via chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

export interface SwSearchResult {
  kind: "memory.search.result";
  requestId: string;
  snippets: string[];
  error?: string;
}

export type SwToContentMessage = SwSearchResult;

// ---------------------------------------------------------------------------
// Native Messaging bridge ops (SW → usrcp-bridge.js)
// ---------------------------------------------------------------------------

export interface BridgeAppendOp {
  op: "ledger.append";
  turn: CapturedTurn;
}

export interface BridgeSearchOp {
  op: "memory.search";
  q: string;
  limit?: number;
  requestId: string;
}

export interface BridgePingOp {
  op: "ping";
}

export type BridgeOp = BridgeAppendOp | BridgeSearchOp | BridgePingOp;

// ---------------------------------------------------------------------------
// Bridge → service-worker responses
// ---------------------------------------------------------------------------

export interface BridgeSearchResponse {
  op: "memory.search.result";
  requestId: string;
  snippets: string[];
  error?: string;
}

export interface BridgePongResponse {
  op: "pong";
}

export type BridgeResponse = BridgeSearchResponse | BridgePongResponse;
