# USRCP iMessage — End-to-End Vision Demo

> **Most users want `usrcp setup` instead.** This document is a reference for what the wizard automates. Follow these steps manually only if you have a reason not to use the wizard.

This is the manual walkthrough for the iMessage adapter's cross-chat memory proof:

> **Bot reply in chat B references content captured from chat A.**

The automated tests in `src/__tests__/` already verify capture filters, ciphertext at rest, restart persistence, and schema guard behavior. This document walks you through the one criterion that requires a live Messages.app and a real Anthropic API call.

---

> **CRITICAL: macOS only.** This adapter will not run on Linux or Windows. The `os: ["darwin"]` field in `package.json` signals this but does not enforce it at install time on all package managers.

> **CRITICAL: Full Disk Access required.** The terminal (or launchd agent) running `usrcp-imessage` must have Full Disk Access in System Settings → Privacy & Security → Full Disk Access. Without it, `imsg` cannot read `~/Library/Messages/chat.db` and the watcher exits immediately.

> **CRITICAL: Messages.app must be open and signed in.** No Messages.app process = no sends. The `imsg` watcher can still capture received messages from the local database, but replies via `imsg send` will fail if Messages.app is not running.

> **First send triggers an Automation consent popup.** When the bot sends its first reply, macOS will ask "Terminal wants to control Messages." Click Allow. Subsequent sends are silent.

---

## Full Disk Access setup

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click the `+` button
3. Add your terminal app:
   - **Terminal.app**: `/System/Applications/Utilities/Terminal.app`
   - **iTerm2**: `/Applications/iTerm.app`
   - **Warp**: `/Applications/Warp.app`
4. Ensure the toggle next to your terminal is **on**
5. Restart the terminal session

To verify FDA is working:
```bash
imsg chats --json --limit 1
# Should output a JSON array of chats, not an error
```

---

## Prerequisites

### 1. Install imsg

```bash
brew install steipete/tap/imsg
```

Confirm version:
```bash
imsg --version
# imsg 0.4.0
```

### 2. Ensure Messages.app is running and signed in

Open Messages.app and confirm you can send and receive messages. The bot will send via AppleScript, so Messages.app must be authenticated with your Apple ID.

### 3. Install usrcp-imessage

```bash
cd /path/to/usrcp
npm install
cd packages/usrcp-imessage
npm install && npm run build
```

---

## Setup wizard

Run the unified wizard:

```bash
usrcp setup --adapter=imessage
```

The wizard walks through:
1. imsg installation check (offers `brew install` if missing)
2. Full Disk Access detection (with System Settings deeplink if denied)
3. Messages.app running check (offers to open it)
4. Your iMessage handle (phone or email — you know your own handle)
5. Chat allowlist via `imsg chats --json` multi-select
6. Trigger prefix (default: `..u ` — two dots + u + space)
7. Anthropic API key validation (1-token test call)

Config is saved to `~/.usrcp/imessage-config.json` at mode 0600.

---

## The demo

### Goal

Send a message in **chat A** about what you're working on. Switch to **chat B** (a group chat). Type `..u what was I just working on?` — the bot replies with context from chat A.

### Step 1: Start the watcher

```bash
# In a terminal with Full Disk Access:
USRCP_PASSPHRASE=<your-passphrase> usrcp-imessage
```

You'll see:
```
[usrcp-imessage] Started — watching for messages
[usrcp-imessage] Allowlisted chats: 7, 9
[usrcp-imessage] Reply prefix (groups): "..u "
```

### Step 2: Send a message in chat A (1:1 DM)

Open Messages.app. In chat A (a 1:1 conversation), send:

```
Just finished the USRCP iMessage adapter — handles crypto-at-rest, prefix triggers, and the FDA dance
```

The watcher captures it:
```
[usrcp-imessage] captured guid=p:0/ABC123 chat=7 → event evt_abc123 (seq 1)
```

### Step 3: Trigger a reply in chat B (group chat)

Switch to chat B (a group chat). Send:

```
..u what was I just working on?
```

The bot replies (via Messages.app) within a few seconds with something like:

> You just finished the USRCP iMessage adapter — you mentioned it handles crypto-at-rest, prefix triggers, and the FDA permission dance.

The watcher logs:
```
[usrcp-imessage] replied to guid=p:0/DEF456 in chat=9 (147 chars)
```

### What you're seeing

- Chat A activity was captured into the encrypted ledger as a `communication` domain event
- When the group chat trigger fires, `composeAndReply` builds a system prompt including the global timeline (chat A's event) and the chat B local timeline
- The LLM's response references what you said in chat A — cross-chat context working
- The bot's reply is itself recorded in the ledger with `intent: agent_reply` for future continuity

---

## Reactions are skipped

If someone "Loves" one of your messages, that generates an `associated_message_type` event (value 2000-3007). The watcher skips these before they reach the capture or reply pipeline. "Loved 'ok'" will not appear in your ledger.

---

## iCloud-only Apple ID (no SIM, no paired iPhone)

If your Mac is iCloud-only, `imsg send` can only deliver to iMessage recipients (blue bubble). SMS fallback (green bubble) requires a paired iPhone. If a send fails, the watcher logs the error and continues — it does not retry via SMS.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `imsg watch` exits immediately | No Full Disk Access | Grant FDA to terminal in System Settings |
| Bot doesn't reply to group | Prefix mismatch | Check `~/.usrcp/imessage-config.json` → `prefix` field |
| First reply stalls | Automation consent | Look for the macOS popup; click Allow |
| `imsg: command not found` | imsg not installed | `brew install steipete/tap/imsg` |
| Bot replies to DMs but not groups | Working as designed — groups need prefix | Send `..u <your question>` |
| `Messages.app not running` error on send | Messages.app closed | Open Messages.app |

---

## Restarting after a gap

The watcher persists `last_rowid` in `~/.usrcp/imessage-config.json` (debounced, flushed on SIGINT). On restart:

```bash
USRCP_PASSPHRASE=<pp> usrcp-imessage
# [usrcp-imessage] Resuming from rowid 12345
```

Messages received while the watcher was down are replayed from the resume point. Reactions are still skipped.

---

## Reset

```bash
usrcp-imessage --reset-config
# Re-runs the full setup wizard
```

Or manually:
```bash
rm ~/.usrcp/imessage-config.json
usrcp setup --adapter=imessage
```
