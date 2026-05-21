# USRCP Chrome Extension — End-to-End Demo

> **Most users want `usrcp setup --adapter=extension` instead.** This is the manual proof script for the Chrome MV3 extension — what the wizard automates, plus a smoke test for both the capture and slash-command paths.

What this walkthrough proves:

> **(1)** A turn you send on claude.ai is captured into the USRCP ledger via the extension's network-level fetch patch, and
> **(2)** typing `/usrcp <query>` in the claude.ai composer retrieves matching ledger context and injects it for review before you send.

The extension is the only USRCP component that combines capture **and** active injection, so the walkthrough has two arms.

---

## Prereqs

- macOS or Linux. **Chrome only** for v0 — Firefox support is deferred.
- USRCP core installed and `usrcp init` already run.
- Node on PATH (the native messaging host uses `/usr/bin/env node`).

Unpacked install — no Web Store listing yet.

---

## Setup (one-time, ~3 minutes)

```bash
cd packages/usrcp-extension
npm install
npm run build
```

This produces `dist/` with `manifest.json`, `service-worker.js`, `content-claude.js`, `page-hook.js`, plus the wizard modules.

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. **Load unpacked** → select `packages/usrcp-extension/dist/`.
4. The extension card appears with a 32-character **ID** (lowercase a–p). Copy it.

Now run the wizard:

```bash
usrcp setup --adapter=extension
```

The wizard:
1. Verifies the native host script exists.
2. Prompts you to paste the extension ID (validated as `^[a-p]{32}$`).
3. Writes the Chrome Native Messaging manifest:
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.usrcp.bridge.json`
4. Writes `~/.usrcp/extension-config.json` at mode `0600`.

**Reload the extension** in `chrome://extensions` (click the refresh icon on the USRCP card) so it picks up the new NM manifest.

---

## Pre-flight: passphrase

If `usrcp init` was passphrase-mode, Chrome needs to inherit `USRCP_PASSPHRASE`. The native host inherits from the shell that launched Chrome.

```bash
export USRCP_PASSPHRASE="your-passphrase"
# Fully quit Chrome (Cmd-Q, not just close window) and relaunch from this shell:
open -a "Google Chrome"
```

For GUI launches on macOS, `launchctl setenv USRCP_PASSPHRASE "your-passphrase"` works until reboot; for persistence install a LaunchAgent plist (see main README → "Passphrase mode and terminal agents").

---

## Proof walkthrough — capture (arm 1)

```bash
# Tail: in another terminal
USRCP_PASSPHRASE="your-passphrase" usrcp status
```

1. Open <https://claude.ai>.
2. Start a new chat. Send a message: `usrcp demo proof capture`.
3. Wait for Claude's reply to finish streaming.
4. Re-run `usrcp status` (or `usrcp recent --domain=claude-ai --limit=5`).

**Expected:** the turn appears in the ledger with both your message and the assistant's response captured. The capture happens at the network layer (fetch patch on `/backend-api/conversation`), so DOM changes do not break it.

✅ If the turn shows up, arm 1 passes.

---

## Proof walkthrough — slash command (arm 2)

In the same claude.ai composer:

1. Type `/usrcp demo proof capture` (using a substring of what you just sent).
2. Press **Enter**.

**Expected:** the composer line does NOT send as a prompt. Instead, the extension replaces the composer text with:

```
Context from my USRCP ledger:
> [<timestamp>] <summary of the turn you just sent>

```

3. Review the injected context, edit if needed, and send the augmented prompt yourself.

✅ If the slash command suppresses the send + injects context, arm 2 passes.

---

## What this does NOT prove

- **ChatGPT support** — deferred to v0.5 (different conversation endpoint).
- **Firefox support** — deferred (manifest variant + Firefox NM path).
- **Stable extension ID** — unpacked loads get a random ID based on source path. Re-loading from a moved directory changes the ID and breaks the NM manifest until you re-run setup.

---

## Troubleshooting

- **"Could not establish connection" in the service worker console** — NM host not installed or extension ID in the NM manifest is wrong. Re-run `usrcp setup --adapter=extension` with the current ID from `chrome://extensions`.
- **Capture works but `/usrcp` slash does nothing** — the composer DOM selector may have shifted. Check the service worker console (chrome://extensions → USRCP → "Service Worker" link).
- **Turns not appearing in `usrcp status`** — check the service worker console for native-host connection errors; verify `USRCP_PASSPHRASE` is set in the env Chrome inherited.
- **NM host fails to start** — `chmod +x packages/usrcp-extension/native-host/usrcp-bridge.js` and confirm `node` is on the PATH used by Chrome's parent shell.
- **Extension ID changed on me** — moving the `dist/` directory changes the unpacked ID. Either keep the directory stable, or accept re-running setup after moves.
