/**
 * page-hook.ts — MAIN world fetch interceptor for claude.ai.
 *
 * v0.1.6 architecture: this script no longer runs at load time. The service
 * worker injects it into the MAIN world via chrome.scripting.executeScript
 * with files:["page-hook.js"] world:"MAIN". That load is CSP-safe because
 * the extension runtime executes it directly, not the page DOM.
 *
 * Loading defines globalThis.__USRCP_INSTALL_HOOK__(secretHex) but does not
 * call it. The SW immediately follows with a second executeScript that has
 * func:invokeAndDelete + args:[secretHex] to call the installer with the
 * per-tab secret then remove the global. After that the secret lives only
 * in the closure of the patched window.fetch.
 *
 * Why two steps instead of inlining everything into the func: page-hook
 * needs sse parsing + mac helpers (~300 lines). Bundling all of that into
 * a single chrome.scripting.executeScript({func}) call means a function
 * literal whose .toString() is the entire bundle; doable but the build
 * gymnastics aren't worth it when the two-step approach is just as secure.
 *
 * Race window: a script that runs between the two executeScripts could
 * grab __USRCP_INSTALL_HOOK__ and call it with their own secret, installing
 * a parallel fetch patch. They cannot affect OURS — when we call the
 * installer with our secret, our fetch patch wraps over theirs. Their patch
 * still runs (signs with their secret), but content-claude only verifies
 * against our secret, so their messages are dropped.
 *
 * The fetch patch tees the SSE response body. One reader goes back to the
 * page (so claude.ai's UI works normally). The other is parsed for
 * content_block_delta events, assembled into a CapturedTurn, signed with
 * the closure-captured secret, and posted to the isolated-world content
 * script via window.postMessage.
 */

import { parseSSEStreamFromReader, extractConversationId } from "./sse.js";
import type { PageHookTurnMessage } from "./shared/types.js";
import { signTurn, hexToSecret } from "./shared/mac.js";

const COMPLETION_PATTERN = /\/chat_conversations\/[^/]+\/completion/;

/**
 * Install the fetch patch with `secretHex` captured in its closure. Idempotent
 * within a tab — if called more than once, only the most recent secret will
 * verify against content-claude, but every prior patch remains in the chain
 * and continues to sign-and-post (dropped by the receiver).
 */
function installHook(secretHex: string): void {
  if (typeof secretHex !== "string" || secretHex.length !== 64) {
    console.debug("[usrcp] page-hook: invalid secretHex; capture disabled");
    return;
  }
  const SECRET = hexToSecret(secretHex);
  const origFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
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
}

// Expose the installer; the SW's second executeScript reads + deletes this
// then calls it with the per-tab secret.
(globalThis as { __USRCP_INSTALL_HOOK__?: (secretHex: string) => void })
  .__USRCP_INSTALL_HOOK__ = installHook;
