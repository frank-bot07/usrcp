/**
 * Interactive setup wizard for the USRCP iMessage adapter.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=imessage`).
 * Walks the user through imsg detection, Full Disk Access check,
 * Messages.app check, user handle, chat allowlist, prefix, and Anthropic key.
 *
 * Exports:
 *   runImessageSetup()  — full interactive flow; writes imessage-config.json;
 *                         returns the persisted ImessageConfig object.
 *
 * macOS-only: throws at the top if process.platform !== "darwin".
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getConfigPath, writeImessageConfig, readPartialConfig, type ImessageConfig } from "./config.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Minimal prompt helpers (no @inquirer/prompts dep — keeps usrcp-imessage lean)
// ---------------------------------------------------------------------------

function readMaskedLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);

    let buf = "";
    const CODE_NL = 10;
    const CODE_CR = 13;
    const CODE_EOT = 4;
    const CODE_ETX = 3;
    const CODE_BS = 8;
    const CODE_DEL = 127;

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === CODE_NL || code === CODE_CR || code === CODE_EOT) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (code === CODE_ETX) {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (code === CODE_BS || code === CODE_DEL) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else {
          buf += ch;
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function readPlainLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(chunk.replace(/\r?\n$/, ""));
    };
    stdin.on("data", onData);
  });
}

function readYN(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return readPlainLine(`${prompt} ${hint} `).then((ans) => {
    const a = ans.trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  });
}

function readMultiSelect(prompt: string, options: string[]): Promise<number[]> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    for (let i = 0; i < options.length; i++) {
      process.stderr.write(`    [${i + 1}] ${options[i]}\n`);
    }
    process.stderr.write("\n");
    readPlainLine(`  Enter numbers to allowlist (comma-separated, e.g. 1,3) or 'all':\n  > `).then((raw) => {
      const trimmed = raw.trim();
      if (trimmed.toLowerCase() === "all") {
        resolve(options.map((_, i) => i));
        return;
      }
      const nums = trimmed
        .split(/[,\s]+/)
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((n) => !isNaN(n) && n >= 0 && n < options.length);
      resolve(nums);
    });
  });
}

// ---------------------------------------------------------------------------
// imsg helpers
// ---------------------------------------------------------------------------

/**
 * Check if imsg is installed and accessible.
 */
async function checkImsgInstalled(): Promise<boolean> {
  try {
    await execFileP("which", ["imsg"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check Full Disk Access by running imsg chats --json --limit 1.
 * Returns { ok: true } on success, or { ok: false, fdaDenied: boolean, stderr: string }.
 */
async function checkFda(): Promise<{ ok: boolean; fdaDenied: boolean; stderr: string }> {
  try {
    await execFileP("imsg", ["chats", "--json", "--limit", "1"]);
    return { ok: true, fdaDenied: false, stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect FDA denial by common error patterns from macOS TCC
    const fdaPattern = /auth|denied|disk access|tcc|permission|not allowed/i;
    const fdaDenied = fdaPattern.test(msg);
    return { ok: false, fdaDenied, stderr: msg };
  }
}

interface ImsgChat {
  rowid: number;
  display_name?: string;
  participants?: string[];
  chat_identifier?: string;
  // Other fields may exist — we only require rowid + one identifier
}

/**
 * Fetch available chats via imsg chats --json.
 * Returns an array of chats with rowid and display name.
 */
async function fetchChats(limit = 100): Promise<
  | { ok: true; chats: Array<{ rowid: string; display: string }> }
  | { ok: false; reason: string; rawFields?: string[] }
> {
  try {
    const { stdout } = await execFileP("imsg", [
      "chats", "--json", "--limit", String(limit),
    ]);
    const parsed: unknown = JSON.parse(stdout.trim());

    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "imsg chats output was not a JSON array." };
    }

    // Schema guard: ensure each item has at least rowid + one identifier
    if (parsed.length > 0) {
      const first = parsed[0] as Record<string, unknown>;
      if (!("rowid" in first)) {
        const fields = Object.keys(first);
        return {
          ok: false,
          reason: `Unexpected chat schema (missing 'rowid'). Got fields: ${fields.join(", ")}`,
          rawFields: fields,
        };
      }
    }

    const chats = (parsed as ImsgChat[]).map((c) => {
      const rowid = String(c.rowid);
      let displayName: string;
      if (c.display_name && c.display_name.trim()) {
        displayName = c.display_name;
      } else if (c.participants && c.participants.length > 0) {
        displayName = c.participants.join(", ");
      } else if (c.chat_identifier) {
        displayName = c.chat_identifier;
      } else {
        displayName = `Chat ${rowid}`;
      }
      return { rowid, display: `${displayName} (rowid: ${rowid})` };
    });

    return { ok: true, chats };
  } catch (err) {
    return { ok: false, reason: `Failed to fetch chats: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Validate an Anthropic API key by attempting a 1-token test call.
 */
async function validateAnthropicKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("invalid x-api-key") || msg.includes("authentication")) {
      return { ok: false, reason: "Invalid API key (401)." };
    }
    // Other errors (network, rate-limit) — treat as key possibly valid
    return { ok: true };
  }
}

/**
 * Validate an iMessage handle format.
 * Must be email (contains @) or phone (starts with + and 8+ digits).
 */
function isValidHandle(handle: string): boolean {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return true;
  // Phone: starts with + followed by 8+ digits (with optional dashes/spaces)
  if (trimmed.startsWith("+")) {
    const digits = trimmed.replace(/\D/g, "");
    return digits.length >= 8;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

export async function runImessageSetup(): Promise<ImessageConfig> {
  // Platform gate — iMessage is macOS-only
  if (process.platform !== "darwin") {
    throw new Error("iMessage adapter requires macOS. Skipping configuration.");
  }

  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-imessage setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  const existing = readPartialConfig();

  process.stderr.write("\n");
  process.stderr.write("  ┌─ iMessage adapter setup ────────────────────────────────────┐\n");
  process.stderr.write("  │ macOS-only. Requires imsg, Full Disk Access, Messages.app.   │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/imessage-config.json (mode 0600)    │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Step 1 — Check imsg is installed ──────────────────────────────────────
  process.stderr.write("  Step 1 — Check imsg is installed\n");
  process.stderr.write("  ─────────────────────────────────\n");

  let imsgInstalled = await checkImsgInstalled();

  if (!imsgInstalled) {
    process.stderr.write("  imsg is not installed.\n");
    process.stderr.write("  Install with: brew install steipete/tap/imsg\n\n");

    const doInstall = await readYN("  Install via brew now?");
    if (doInstall) {
      process.stderr.write("  Running: brew install steipete/tap/imsg\n\n");
      try {
        execFileSync("brew", ["install", "steipete/tap/imsg"], { stdio: "inherit" });
        imsgInstalled = await checkImsgInstalled();
        if (!imsgInstalled) {
          process.stderr.write("  brew install completed but imsg still not found. Check PATH.\n");
          process.exit(1);
        }
        process.stderr.write("  ✓ imsg installed.\n\n");
      } catch {
        process.stderr.write("  brew install failed. Install manually:\n");
        process.stderr.write("    brew install steipete/tap/imsg\n");
        process.stderr.write("  Then re-run: usrcp setup --adapter=imessage\n");
        process.exit(1);
      }
    } else {
      process.stderr.write("  Cannot proceed without imsg. Install it and re-run setup.\n");
      process.exit(1);
    }
  } else {
    process.stderr.write("  ✓ imsg found.\n\n");
  }

  // ── Step 2 — Check Full Disk Access ──────────────────────────────────────
  process.stderr.write("  Step 2 — Full Disk Access (FDA)\n");
  process.stderr.write("  ────────────────────────────────\n");
  process.stderr.write("  Testing access to Messages data...\n");

  let fdaOk = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fdaResult = await checkFda();
    if (fdaResult.ok) {
      fdaOk = true;
      process.stderr.write("  ✓ Full Disk Access confirmed.\n\n");
      break;
    }

    if (attempt === 0) {
      process.stderr.write("  Full Disk Access is required for the terminal running this setup.\n");
      if (fdaResult.fdaDenied) {
        process.stderr.write("  (Detected: TCC/authorization denial)\n");
      } else {
        process.stderr.write(`  (Error: ${fdaResult.stderr.slice(0, 200)})\n`);
      }
      process.stderr.write("\n");
      process.stderr.write("  How to grant Full Disk Access:\n");
      process.stderr.write("    System Settings → Privacy & Security → Full Disk Access\n");
      process.stderr.write("    Add your terminal app (Terminal.app, iTerm2, etc.)\n\n");

      const openSettings = await readYN("  Open System Settings now?");
      if (openSettings) {
        try {
          await execFileP("open", [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
          ]);
        } catch {
          // ignore — user will open manually
        }
      }

      await readPlainLine("  Grant FDA to your terminal, then press Enter to re-test: ");
    } else {
      process.stderr.write("  Still unable to access Messages data.\n");
      process.stderr.write("  Grant Full Disk Access to your terminal and re-run setup.\n");
      process.exit(1);
    }
  }

  if (!fdaOk) {
    process.stderr.write("  FDA check failed. Grant Full Disk Access and re-run setup.\n");
    process.exit(1);
  }

  // ── Step 3 — Check Messages.app is running ────────────────────────────────
  process.stderr.write("  Step 3 — Messages.app\n");
  process.stderr.write("  ─────────────────────\n");

  let messagesRunning = false;
  try {
    execFileSync("pgrep", ["-x", "Messages"], { stdio: "ignore" });
    messagesRunning = true;
  } catch {
    messagesRunning = false;
  }

  if (!messagesRunning) {
    process.stderr.write("  Messages.app is not running.\n");
    process.stderr.write("  Open it and sign in with your Apple ID before continuing.\n\n");

    const openMessages = await readYN("  Open Messages.app now?");
    if (openMessages) {
      try {
        await execFileP("open", ["-a", "Messages"]);
      } catch {
        // ignore
      }
    }

    await readPlainLine("  Sign in to Messages, then press Enter to continue: ");
  } else {
    process.stderr.write("  ✓ Messages.app is running.\n\n");
  }

  // ── Step 4 — User handle ──────────────────────────────────────────────────
  process.stderr.write("  Step 4 — Your iMessage handle\n");
  process.stderr.write("  ──────────────────────────────\n");
  process.stderr.write("  This identifies your outgoing messages (is_from_me=1).\n");
  process.stderr.write("  Use the phone number or email you registered with iMessage.\n\n");

  let user_handle = "";
  while (true) {
    const raw = await readPlainLine(
      `  Your iMessage handle (${existing.user_handle ? `existing: ${existing.user_handle}, Enter to keep` : "phone +1... or email"}):\n  > `
    );
    const trimmed = raw.trim();
    if (!trimmed && existing.user_handle) {
      user_handle = existing.user_handle;
      process.stderr.write(`  ✓ Keeping existing handle: ${user_handle}\n\n`);
      break;
    }
    if (!trimmed) {
      process.stderr.write("  Handle cannot be empty.\n");
      continue;
    }
    if (!isValidHandle(trimmed)) {
      process.stderr.write("  Invalid format. Use email (contains @) or phone (+1 followed by 8+ digits).\n");
      continue;
    }
    user_handle = trimmed;
    process.stderr.write(`  ✓ Handle: ${user_handle}\n\n`);
    break;
  }

  // ── Step 5 — Allowlisted chats ────────────────────────────────────────────
  process.stderr.write("  Step 5 — Allowlisted chats\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Fetching available chats (up to 100)...\n");

  let allowlisted_chats: string[] = [];

  const chatsResult = await fetchChats(100);
  if (!chatsResult.ok) {
    process.stderr.write(`  Warning: could not fetch chat list: ${chatsResult.reason}\n`);
    if (chatsResult.rawFields) {
      process.stderr.write(`  Actual fields returned: ${chatsResult.rawFields.join(", ")}\n`);
    }
    process.stderr.write("  You can paste chat ROWIDs manually instead.\n\n");

    while (true) {
      const raw = await readPlainLine(
        "  Paste chat ROWIDs (comma-separated, e.g. 1,5,12):\n  > "
      );
      const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (ids.length === 0) {
        process.stderr.write("  At least one chat ROWID is required.\n");
        continue;
      }
      allowlisted_chats = ids;
      process.stderr.write(`  ✓ ${ids.length} chat${ids.length === 1 ? "" : "s"} added.\n\n`);
      break;
    }
  } else {
    const { chats } = chatsResult;
    if (chats.length === 0) {
      process.stderr.write("  No chats found. Open Messages.app and start a conversation first.\n");
      process.exit(1);
    }

    process.stderr.write(`  Found ${chats.length} chat${chats.length === 1 ? "" : "s"} (capped at 100):\n\n`);

    let selectedIndices: number[] = [];
    while (true) {
      selectedIndices = await readMultiSelect(
        "",
        chats.map((c) => c.display)
      );
      if (selectedIndices.length === 0) {
        process.stderr.write("  Select at least one chat. Try again.\n\n");
        continue;
      }
      allowlisted_chats = selectedIndices.map((i) => chats[i].rowid);
      process.stderr.write(
        `  ✓ ${allowlisted_chats.length} chat${allowlisted_chats.length === 1 ? "" : "s"} selected.\n\n`
      );
      break;
    }
  }

  // ── Step 6 — Prefix ───────────────────────────────────────────────────────
  process.stderr.write("  Step 6 — Group chat trigger prefix\n");
  process.stderr.write("  ────────────────────────────────────\n");
  process.stderr.write("  Group chats only respond to messages starting with this prefix.\n");
  process.stderr.write("  DMs always respond. Default: '..u ' (two dots + u + space)\n\n");

  let prefix = "";
  while (true) {
    const existingPrefix = existing.prefix ?? "..u ";
    const raw = await readPlainLine(
      `  Prefix (Enter for "${existingPrefix}"):\n  > `
    );
    const trimmed = raw.trim();
    if (!trimmed) {
      prefix = existingPrefix;
    } else {
      // Normalize: trim and ensure trailing space
      prefix = trimmed.endsWith(" ") ? trimmed : trimmed + " ";
    }
    if (prefix.length === 0) {
      process.stderr.write("  Prefix cannot be empty.\n");
      continue;
    }
    process.stderr.write(`  ✓ Prefix set to: "${prefix}"\n\n`);
    break;
  }

  // ── Step 7 — Anthropic API key ────────────────────────────────────────────
  process.stderr.write("  Step 7 — Anthropic API key\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Used for summarization and replies. Get one at:\n");
  process.stderr.write("  https://console.anthropic.com/account/keys\n\n");

  let anthropic_api_key = "";
  while (true) {
    anthropic_api_key = await readMaskedLine("  Paste your Anthropic API key: ");
    if (!anthropic_api_key.trim()) {
      process.stderr.write("  Key cannot be empty. Try again.\n");
      continue;
    }
    process.stderr.write("  Validating key (1-token test call)...\n");
    const keyResult = await validateAnthropicKey(anthropic_api_key);
    if (!keyResult.ok) {
      process.stderr.write(`  ${keyResult.reason ?? "Invalid key."} Try again.\n`);
      continue;
    }
    process.stderr.write("  ✓ Anthropic key works.\n\n");
    break;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const cfg: ImessageConfig = {
    anthropic_api_key,
    user_handle,
    allowlisted_chats,
    prefix,
    ...(existing.last_rowid !== undefined ? { last_rowid: existing.last_rowid } : {}),
  };

  writeImessageConfig(cfg);

  process.stderr.write(`  ✓ iMessage adapter configured. Config saved to ${getConfigPath()} (mode 0600)\n`);
  process.stderr.write("\n");
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-imessage\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-imessage\n\n");
  process.stderr.write("  Note: The first time the bot replies, macOS will ask for\n");
  process.stderr.write("  Automation permission (one-time popup). Approve it.\n\n");

  return cfg;
}
