# usrcp-extension

Chrome browser extension (MV3) that captures claude.ai conversations into the
encrypted USRCP ledger and injects ledger context via a `/usrcp <query>` slash
command in the composer.

**v0 scope:** Chrome only, claude.ai only, manual "Load Unpacked" install.

---

## Architecture

```
claude.ai tab
  └── page-hook.js          (MAIN world)
        window.fetch patch → tee SSE → parse content_block_delta
        → window.postMessage → content-claude.js

  └── content-claude.js     (isolated world)
        receives turn from page hook → chrome.runtime.sendMessage → SW
        intercepts /usrcp <query> keydown → chrome.runtime.sendMessage → SW
        receives search results from SW → sets composer text

service-worker.js
  owns chrome.runtime.connectNative("com.usrcp.bridge")
  20s heartbeat to keep SW alive
  routes ledger.append + memory.search to native host

native-host/usrcp-bridge.js   (Node.js, stdio framing)
  reads/writes Chrome NM 4-byte LE length-prefixed JSON frames
  imports usrcp-local directly, calls Ledger.appendEvent / Ledger.searchTimeline
  no MCP server in the middle for v0
```

---

## Prerequisites

- Chrome (any recent version with MV3 support — Chrome 88+)
- Node.js ≥ 20 (for the native host)
- A configured USRCP ledger: `usrcp setup`

---

## Install

### 1. Build the extension

```bash
cd packages/usrcp-extension
npm install
npm run build
```

This produces `dist/` containing:
- `manifest.json`
- `service-worker.js`
- `content-claude.js`
- `page-hook.js`
- `setup.js` + `config.js` (wizard modules)

### 2. Run the wizard

```bash
usrcp setup --adapter=extension
```

The wizard will:
1. Verify `native-host/usrcp-bridge.js` exists.
2. Tell you to open Chrome → chrome://extensions → Developer Mode → Load Unpacked → select `packages/usrcp-extension/dist/`.
3. Prompt you to paste the extension ID shown in chrome://extensions.
4. Write the Chrome Native Messaging manifest at:
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.usrcp.bridge.json`
5. Write `~/.usrcp/extension-config.json` (mode 0600).

### 3. Reload the extension

After the wizard completes, click the reload icon on the USRCP extension card
in chrome://extensions to pick up the newly installed NM manifest.

---

## Usage

### Capture (automatic)

Once the extension is loaded and the native host is installed, every claude.ai
conversation is automatically captured into your USRCP ledger. The capture
happens at the network layer (fetch patch) — no DOM scraping.

### Slash command (inject context)

In any claude.ai composer, type:

```
/usrcp <your query>
```

Press Enter. The extension:
1. Prevents the line from being sent as a prompt.
2. Searches your ledger for relevant context.
3. Replaces the composer content with:
   ```
   Context from my USRCP ledger:
   > [2026-04-20] We discussed the USRCP architecture...
   > [2026-04-18] Implemented the Discord adapter...

   ```
4. You review, edit if needed, and send the augmented prompt yourself.

The augmentation is always visible and editable — no silent prompt rewriting.

---

## Verification

After loading the extension and running setup:

1. Open claude.ai and send a test message.
2. Check that a turn was captured:
   ```bash
   usrcp status
   ```
3. Type `/usrcp test` in the composer and press Enter.
   You should see context snippets appear (or "no results" if the ledger is empty).

---

## Environment variable

If your ledger uses a passphrase, set `USRCP_PASSPHRASE` in your shell
environment before Chrome starts (macOS: add to `~/.zshrc` / `~/.bash_profile`,
then restart Chrome). The native host inherits the environment from the shell
that launched Chrome.

```bash
export USRCP_PASSPHRASE="your-passphrase"
```

---

## Troubleshooting

**Extension shows "Could not establish connection" in the console:**
- The native host is not installed or the extension ID in the NM manifest is wrong.
- Re-run `usrcp setup --adapter=extension` and paste the correct extension ID.

**`/usrcp` slash command does nothing:**
- The composer selector may have changed. Check the browser console for errors.
- File an issue with the DOM structure of the composer at your claude.ai version.

**Captures not appearing in `usrcp status`:**
- Check for errors in the extension's service worker console
  (chrome://extensions → USRCP → "Service Worker" link → Console).
- Verify `USRCP_PASSPHRASE` is set if you use passphrase mode.

**NM host fails to start:**
- Ensure `native-host/usrcp-bridge.js` is executable: `chmod +x native-host/usrcp-bridge.js`
- Ensure `node` is on your PATH (the shebang uses `/usr/bin/env node`).

---

## Deferred to v0.1

- **Firefox support** — ~30-line manifest variant; requires `browser_specific_settings` and the Firefox NM manifest path.
- **Stable extension ID** — unpacked loads get a random ID based on source path. A published `key` field in `manifest.json` makes it stable; requires Chrome Web Store coordination.

## Deferred to v0.5

- Sidebar / ledger browser UI.
- ChatGPT support (`/backend-api/conversation`).

## Deferred (open question)

- Reproducible build pipeline + Web Store publication. Trust budget for
  AI-chat-reading extensions is thin; source-verifiable builds are important.
  Tracked in the PR as an open question.

---

## Permissions

Requested: `nativeMessaging`, `storage`, `scripting`
Host permissions: `https://claude.ai/*` only

NOT requested: `<all_urls>`, `cookies`, `webRequest`, `tabs` (broad form),
`history`, `downloads`.
