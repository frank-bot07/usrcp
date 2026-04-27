/**
 * page-hook.ts — MAIN world fetch interceptor for claude.ai
 *
 * Injected into the MAIN world via the manifest `content_scripts` declaration
 * with `"world": "MAIN"`. This gives direct access to `window.fetch` and the
 * page's JavaScript context.
 *
 * STOP CONDITION NOTE (CSP):
 * If claude.ai's Content-Security-Policy blocks MAIN-world content scripts
 * declared in the manifest, the fallback is to inject this script dynamically
 * from the isolated-world content script using chrome.scripting.executeScript
 * with world: "MAIN" triggered after webNavigation.onCommitted. This is
 * documented here so Frank can verify live. The manifest approach is correct
 * per Chrome MV3 spec and should work, but CSP enforcement varies by page.
 *
 * Architecture note:
 * The fetch patch tees the SSE response body. One reader goes back to the page
 * (so claude.ai's UI works normally). The other is parsed for content_block_delta
 * events and assembled into a final CapturedTurn, which is forwarded to the
 * isolated-world content script via window.postMessage.
 */

import { parseSSEStreamFromReader, extractConversationId } from "./sse.js";
import type { PageHookTurnMessage } from "./shared/types.js";

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
    .then((turn) => {
      if (!turn) return;
      const msg: PageHookTurnMessage = {
        source: "usrcp",
        kind: "turn",
        turn,
      };
      window.postMessage(msg, "*");
    })
    .catch((err: unknown) => {
      // Never crash the page — log quietly
      console.debug("[usrcp] SSE parse error:", err);
    });

  return new Response(pageStream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};
