#!/usr/bin/env node
/**
 * USRCP iMessage adapter entry point.
 *
 *   usrcp-imessage                   # load config, start watcher
 *   usrcp-imessage --reset-config    # re-run 'usrcp setup --adapter=imessage'
 *
 * macOS-only. Requires:
 *   - imsg (brew install steipete/tap/imsg)
 *   - Full Disk Access for the terminal running this process
 *   - Messages.app open and signed in
 *   - USRCP_PASSPHRASE env var if the local ledger is passphrase-protected
 *
 * Trigger model:
 *   - DMs: always trigger a reply
 *   - Group chats: only on configured prefix (default "..u ")
 *   - Capture: user's own messages (is_from_me=1) in allowlisted chats
 *   - Reactions/tapbacks (associated_message_type != 0): skipped entirely
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { execSync } from "node:child_process";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { loadConfig, saveLastRowid, flushLastRowid } from "./config.js";
import { captureMessage, type CaptureMessage } from "./capture.js";
import { composeAndReply } from "./reader.js";
import { AnthropicLlm } from "./llm.js";

const execFileP = promisify(execFile);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Send an iMessage reply via `imsg send --chat-guid`.
 * Uses --chat-guid which is stable for both 1:1 and group chats.
 */
async function send(chatGuid: string, text: string): Promise<void> {
  await execFileP("imsg", [
    "send",
    "--chat-guid", chatGuid,
    "--text", text,
    "--service", "auto",
  ]);
}

/**
 * Validate that required fields are present on a parsed event.
 * Returns the list of missing field names (empty = valid).
 */
function validateEventSchema(evt: unknown): string[] {
  const required = [
    "guid",
    "text",
    "is_from_me",
    "chat_guid",
  ] as const;

  if (typeof evt !== "object" || evt === null) return ["(not an object)"];

  const obj = evt as Record<string, unknown>;
  return required.filter((f) => !(f in obj));
}

async function main() {
  // --reset-config delegates to the unified wizard instead of prompting inline.
  if (hasFlag("reset-config")) {
    console.error("[usrcp-imessage] --reset-config: launching 'usrcp setup --adapter=imessage'...");
    try {
      execSync("usrcp setup --adapter=imessage", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  const config = loadConfig();

  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const llm = new AnthropicLlm({ apiKey: config.anthropic_api_key });

  // Build imsg watch args
  const args = ["watch", "--json", "--debounce", "250ms"];
  if (config.last_rowid !== undefined && config.last_rowid > 0) {
    args.push("--since-rowid", String(config.last_rowid));
  }

  const proc = spawn("imsg", args, { stdio: ["ignore", "pipe", "inherit"] });

  console.error("[usrcp-imessage] Started — watching for messages");
  console.error(`[usrcp-imessage] Allowlisted chats: ${config.allowlisted_chats.join(", ")}`);
  console.error(`[usrcp-imessage] Reply prefix (groups): "${config.prefix}"`);
  if (config.last_rowid) {
    console.error(`[usrcp-imessage] Resuming from rowid ${config.last_rowid}`);
  }

  let buf = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;

      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        console.error("[usrcp-imessage] failed to parse JSON line, skipping:", line.slice(0, 200));
        continue;
      }

      // Runtime schema guard — field names from imsg 0.4.0 are unverified.
      // If the schema differs, log and skip rather than crash.
      const missing = validateEventSchema(evt);
      if (missing.length > 0) {
        console.error(
          `[usrcp-imessage] unexpected event schema, skipping (missing: ${missing.join(", ")}):`,
          line.slice(0, 200)
        );
        continue;
      }

      const obj = evt as Record<string, unknown>;

      // Skip reactions/tapbacks (associated_message_type != 0)
      const assocType = obj["associated_message_type"];
      if (assocType !== undefined && assocType !== null && assocType !== 0 && assocType !== false) {
        const rowid = typeof obj["rowid"] === "number" ? obj["rowid"] as number : undefined;
        if (rowid !== undefined) saveLastRowid(rowid);
        continue;
      }

      // Determine if this is a user-sent message
      const isFromMe = obj["is_from_me"] === 1 || obj["is_from_me"] === true;
      const chatStyle = typeof obj["chat_style"] === "number" ? obj["chat_style"] as number : undefined;
      const chatId = obj["chat_id"] !== undefined ? String(obj["chat_id"]) : obj["chat_guid"] as string;

      const cm: CaptureMessage = {
        id: String(obj["guid"]),
        content: typeof obj["text"] === "string" ? obj["text"] as string : "",
        author: {
          id: isFromMe
            ? config.user_handle
            : (typeof obj["handle"] === "string" ? obj["handle"] as string : "unknown"),
          isUser: isFromMe,
        },
        chat: {
          id: chatId,
          guid: String(obj["chat_guid"]),
          // chat_style 43 = group chat per iMessage's internal encoding
          isGroup: chatStyle === 43,
          displayName: typeof obj["chat_display_name"] === "string"
            ? obj["chat_display_name"] as string
            : undefined,
        },
      };

      // Capture user-sent messages in allowlisted chats
      if (cm.author.isUser && config.allowlisted_chats.includes(cm.chat.id)) {
        captureMessage(ledger, cm, config, llm).then((outcome) => {
          if (outcome.captured) {
            console.error(
              `[usrcp-imessage] captured guid=${cm.id} chat=${cm.chat.id} ` +
              `→ event ${outcome.event_id} (seq ${outcome.ledger_sequence}` +
              `${outcome.duplicate ? ", duplicate" : ""})`
            );
          }
        }).catch((err: unknown) => {
          console.error("[usrcp-imessage] capture error:", err instanceof Error ? err.message : err);
        });
      }

      // Reply trigger:
      //   - incoming message (not from user)
      //   - chat in allowlist
      //   - DM always triggers; group only on prefix
      if (!cm.author.isUser && config.allowlisted_chats.includes(cm.chat.id)) {
        composeAndReply(ledger, cm, config, llm, (text) => send(cm.chat.guid, text)).then((outcome) => {
          if (outcome.replied) {
            console.error(
              `[usrcp-imessage] replied to guid=${cm.id} in chat=${cm.chat.id} (${outcome.replyText.length} chars)`
            );
          } else {
            console.error(
              `[usrcp-imessage] no reply for guid=${cm.id}: ${outcome.reason}`
            );
          }
        }).catch((err: unknown) => {
          console.error("[usrcp-imessage] reply error:", err instanceof Error ? err.message : err);
        });
      }

      // Advance the resume cursor (all events, including skipped/captured)
      const rowid = typeof obj["rowid"] === "number" ? obj["rowid"] as number : undefined;
      if (rowid !== undefined) saveLastRowid(rowid);
    }
  });

  proc.on("exit", (code) => {
    flushLastRowid();
    console.error(`[usrcp-imessage] imsg watch exited with code ${code}`);
    ledger.close();
    process.exit(code ?? 1);
  });

  const shutdown = (signal: string) => {
    console.error(`[usrcp-imessage] ${signal} received, shutting down.`);
    flushLastRowid();
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[usrcp-imessage] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
