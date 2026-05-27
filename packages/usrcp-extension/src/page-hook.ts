/**
 * page-hook.ts — MAIN world fetch interceptor for claude.ai
 *
 * v0.1.6 change: no longer injected via the manifest's MAIN-world
 * content_scripts entry. Instead, content-claude.ts generates a per-tab 32-
 * byte secret, wraps this bundle in an outer IIFE that binds the secret as
 * `__USRCP_SECRET_HEX__`, injects via <script>.textContent at document_start,
 * and removes the element. The secret stays captured in the IIFE closure;
 * every turn is signed with HMAC-SHA256 so the receiver can reject anything
 * forged by another script on the page. See shared/mac.ts for the full
 * rationale.
 *
 * Architecture note:
 * The fetch patch tees the SSE response body. One reader goes back to the page
 * (so claude.ai's UI works normally). The other is parsed for content_block_delta
 * events and assembled into a final CapturedTurn, which is signed with the
 * closure-captured secret and forwarded to the isolated-world content script
 * via window.postMessage.
 */

import { parseSSEStreamFromReader, extractConversationId } from "./sse.js";
import type { PageHookTurnMessage } from "./shared/types.js";
import { signTurn, hexToSecret } from "./shared/mac.js";

// Bound by the outer IIFE that content-claude injects. Declared as a free
// global so esbuild leaves the reference unbundled; at runtime the wrapper
// supplies it via lexical scope. If absent (manual page load with no
// wrapper, e.g. dev) we abort cleanly.
declare const __USRCP_SECRET_HEX__: string;
const secretHex =
  typeof __USRCP_SECRET_HEX__ === "string" && __USRCP_SECRET_HEX__.length === 64
    ? __USRCP_SECRET_HEX__
    : null;
if (!secretHex) {
  console.debug("[usrcp] page-hook: no secret bound; capture disabled");
}
const SECRET = secretHex ? hexToSecret(secretHex) : null;

// ---------------------------------------------------------------------------
// Completion endpoint pattern
// ---------------------------------------------------------------------------

const COMPLETION_PATTERN = /\/chat_conversations\/[^/]+\/completion/;

// ---------------------------------------------------------------------------
// Fetch patch
// ---------------------------------------------------------------------------

const origFetch = window.fetch.bind(window);

window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await origFetch(...args);

  const url = typeof args[0] === "string"
    ? args[0]
    : args[0] instanceof URL
      ? args[0].href
      : (args[0] as Request).url;

  if (!COMPLETION_PATTERN.test(url)) {
    return res;
  }

  const body = res.body;
  if (!body) {
    return res;
  }

  // Tee: one stream for the page, one for our SSE parser
  const [pageStream, ourStream] = body.tee();

  const conversationId = extractConversationId(url);

  // Parse asynchronously — don't block the page's response
  parseSSEStreamFromReader(ourStream.getReader(), conversationId)
    .then(async (turn) => {
      if (!turn) return;
      if (!SECRET) return; // no closure secret bound; drop silently
      const { ts, mac } = await signTurn(turn, SECRET);
      const msg: PageHookTurnMessage = {
        source: "usrcp",
        kind: "turn",
        turn,
        ts,
        mac,
      };
      window.postMessage(msg, "*");
    })
    .catch((err: unknown) => {
      // Never crash the page — log quietly
      console.debug("[usrcp] SSE parse / sign error:", err);
    });

  return new Response(pageStream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};
