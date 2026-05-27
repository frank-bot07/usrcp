/**
 * content-claude.ts — isolated-world content script for claude.ai
 *
 * Owns two channels:
 *  1. Receives signed turn messages from page-hook (MAIN world) and forwards
 *     them to the service worker.
 *  2. The `/usrcp <query>` slash command for in-composer memory recall.
 *
 * v0.1.6 change: page-hook is no longer declared as a MAIN-world content
 * script in the manifest. Instead this script generates a fresh 32-byte
 * secret per tab at document_start, wraps page-hook.js source in an IIFE
 * that binds the secret, injects via <script>.textContent, and removes
 * the element. Every incoming turn is HMAC-verified against the same
 * secret before forwarding; unsigned or forged messages are dropped.
 * See shared/mac.ts for the threat model.
 */

import type {
  PageHookMessage,
  SwAppendMessage,
  SwSearchMessage,
  SwToContentMessage,
} from "./shared/types.js";
import { generateSecret, secretToHex, verifyTurn } from "./shared/mac.js";

// ---------------------------------------------------------------------------
// Generate per-tab secret + inject page-hook with secret bound in closure
// ---------------------------------------------------------------------------

const SECRET = generateSecret();
const SECRET_HEX = secretToHex(SECRET);

(async function injectPageHook() {
  try {
    const url = chrome.runtime.getURL("page-hook.js");
    const src = await (await fetch(url)).text();
    // Bind SECRET_HEX in lexical scope. esbuild bundles page-hook as an
    // IIFE that references __USRCP_SECRET_HEX__ as a free variable; the
    // outer IIFE here provides it via closure. Other scripts on the page
    // cannot read the secret because (a) it is never written to a global,
    // (b) the script element is removed immediately after the browser has
    // parsed it. A mutation observer racing the injection is a residual
    // risk documented in shared/mac.ts.
    const wrapped = `(function(){const __USRCP_SECRET_HEX__=${JSON.stringify(SECRET_HEX)};${src}})();`;
    const el = document.createElement("script");
    el.textContent = wrapped;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (err) {
    console.debug("[usrcp] page-hook injection failed:", err);
  }
})();

// ---------------------------------------------------------------------------
// Forward signed turns from page hook → service worker
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from our own window (postMessage can deliver from
  // iframes; an iframe's content script wouldn't share our SECRET anyway,
  // but rejecting cross-window early avoids unnecessary verify work).
  if (event.source !== window) return;

  const data = event.data as PageHookMessage | undefined;
  if (!data || data.source !== "usrcp" || data.kind !== "turn") return;
  if (typeof data.ts !== "number" || typeof data.mac !== "string") return;
  if (!data.turn || typeof data.turn !== "object") return;

  // Verify HMAC + freshness before trusting the payload. A forger on the
  // page cannot produce a valid mac without SECRET, which lives only in
  // the injected page-hook's closure.
  verifyTurn(data.turn, data.ts, data.mac, SECRET).then((ok) => {
    if (!ok) {
      console.debug("[usrcp] dropped unsigned/forged/stale turn message");
      return;
    }
    const msg: SwAppendMessage = {
      kind: "ledger.append",
      turn: data.turn,
    };
    chrome.runtime.sendMessage(msg).catch((err: unknown) => {
      console.debug("[usrcp] Failed to forward turn to SW:", err);
    });
  });
});

// ---------------------------------------------------------------------------
// Slash command: /usrcp <query>
// ---------------------------------------------------------------------------

/**
 * Find the active composer element on claude.ai.
 * Claude uses a contenteditable div; the selector may need updating if
 * claude.ai's DOM changes. This is the known pattern as of 2026-04.
 */
function findComposer(): HTMLElement | null {
  // Primary: contenteditable div in the chat form
  const el = document.querySelector<HTMLElement>(
    '[contenteditable="true"][data-testid="composer-input"], ' +
    'div[contenteditable="true"].ProseMirror, ' +
    'div[contenteditable="true"][class*="composer"], ' +
    'div[contenteditable="true"]'
  );
  return el ?? null;
}

function getComposerText(el: HTMLElement): string {
  return el.innerText ?? el.textContent ?? "";
}

function setComposerText(el: HTMLElement, text: string): void {
  // For contenteditable divs we set innerText and dispatch input events
  // so React's synthetic event system picks up the change.
  el.focus();
  el.innerText = text;

  // Dispatch native input event
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // Move cursor to end
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Pending search requests keyed by requestId
const pendingSearches = new Map<string, { composer: HTMLElement }>();

let requestCounter = 0;

document.addEventListener("keydown", (event: KeyboardEvent) => {
  // SECURITY (v0.1.3): require a real user keystroke. Without this,
  // malicious page JS on claude.ai could synthesize a keydown event
  // to trigger /usrcp and exfiltrate ledger snippets via the composer
  // DOM (which page JS can read). isTrusted is the browser's flag
  // for "this event came from real user input, not script". Cannot
  // be forged from page JS.
  if (!event.isTrusted) return;

  if (event.key !== "Enter") return;

  const composer = findComposer();
  if (!composer) return;

  // Only intercept if the composer is focused
  if (document.activeElement !== composer && !composer.contains(document.activeElement)) {
    return;
  }

  const text = getComposerText(composer).trim();
  if (!text.startsWith("/usrcp ")) return;

  const query = text.slice("/usrcp ".length).trim();
  if (!query) return;

  // Prevent the /usrcp line from being submitted as a prompt
  event.preventDefault();
  event.stopImmediatePropagation();

  const requestId = `usrcp-search-${++requestCounter}`;
  pendingSearches.set(requestId, { composer });

  // Clear the composer while we search
  setComposerText(composer, "");

  const msg: SwSearchMessage = {
    kind: "memory.search",
    q: query,
    requestId,
  };

  chrome.runtime.sendMessage(msg).catch((err: unknown) => {
    console.debug("[usrcp] Failed to send search to SW:", err);
    pendingSearches.delete(requestId);
  });
}, true /* capture phase — intercept before React's listener */);

// ---------------------------------------------------------------------------
// Handle search results from service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as SwToContentMessage;
  if (!msg || msg.kind !== "memory.search.result") return;

  const pending = pendingSearches.get(msg.requestId);
  if (!pending) return;
  pendingSearches.delete(msg.requestId);

  const { composer } = pending;

  if (msg.error) {
    setComposerText(composer, `[usrcp error: ${msg.error}]\n`);
    return;
  }

  if (msg.snippets.length === 0) {
    setComposerText(composer, "[usrcp: no results found for that query]\n");
    return;
  }

  const contextBlock = [
    "Context from my USRCP ledger:",
    ...msg.snippets.map((s) => `> ${s}`),
    "",
    "",
  ].join("\n");

  setComposerText(composer, contextBlock);
});
