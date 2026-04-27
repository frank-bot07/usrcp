/**
 * content-claude.ts — isolated-world content script for claude.ai
 *
 * page-hook.js runs in the MAIN world via the manifest's content_scripts
 * declaration with `"world": "MAIN"`. This isolated-world script is the bridge:
 * it receives `window.postMessage` events from the page hook and forwards them
 * to the service worker, and it owns the `/usrcp <query>` slash command.
 *
 * Stop condition: if claude.ai's CSP ever rejects the MAIN-world declaration,
 * the documented fallback is `chrome.scripting.executeScript({ world: "MAIN" })`
 * from the service worker on `webNavigation.onCommitted`.
 */

import type {
  PageHookMessage,
  SwAppendMessage,
  SwSearchMessage,
  SwToContentMessage,
} from "./shared/types.js";

// ---------------------------------------------------------------------------
// Forward captured turns from page hook → service worker
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from our own page hook
  if (event.source !== window) return;

  const data = event.data as PageHookMessage | undefined;
  if (!data || data.source !== "usrcp" || data.kind !== "turn") return;

  const msg: SwAppendMessage = {
    kind: "ledger.append",
    turn: data.turn,
  };

  chrome.runtime.sendMessage(msg).catch((err: unknown) => {
    console.debug("[usrcp] Failed to forward turn to SW:", err);
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
