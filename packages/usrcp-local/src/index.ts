#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type ServeOptions } from "./server.js";
import { Ledger } from "./ledger/index.js";
import { initializeIdentity, getIdentity } from "./crypto.js";
import {
  isPassphraseMode,
  initializeMasterKey,
  setUserSlug,
  getUserDir,
  getUsrcpBaseDir,
  listUserSlugs,
  migrateLegacyLayout,
} from "./encryption.js";
import { startHttpTransport, ensureTlsCert, ensureAuthToken } from "./transport.js";
import { readConfig, updateConfig } from "./config.js";
import { syncPush, syncPull, syncStatus } from "./sync.js";
import {
  addTerminalAdapter,
  removeTerminalAdapter,
  listTerminalAdapters,
  detectInstalledTargets,
  parseTargets,
  ALL_TARGETS,
  type TargetName,
} from "./adapters/terminal/index.js";
import { resolveUsrcpBin } from "./adapters/terminal/shared.js";
import { refreshContextMd } from "./adapters/terminal/context-md.js";
import { runSetup } from "./setup.js";

function hasFlag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}`);
}

function getArg(name: string): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].split("=").slice(1).join("=");
  }
  return undefined;
}

/**
 * Resolve which user slug the CLI should operate on. Rules:
 *   --user=<slug>        → use that slug
 *   zero users exist     → "default" (new install) or the slug caller passes to init
 *   exactly one user     → use it
 *   multiple users       → require --user, else error with list of slugs
 *
 * Mutates module state (setUserSlug) and returns the resolved slug.
 */
function resolveUserSlug(opts: { forInit?: boolean } = {}): string {
  const explicit = getArg("user");
  if (explicit) {
    setUserSlug(explicit);
    return explicit;
  }
  const existing = listUserSlugs();
  if (existing.length === 0) {
    // Fresh install — default slug is fine
    return "default";
  }
  if (existing.length === 1) {
    setUserSlug(existing[0]);
    return existing[0];
  }
  if (opts.forInit) {
    // During init with no --user, we want a new slug; caller supplies it or
    // we default to "default" only if it's not taken.
    if (!existing.includes("default")) return "default";
    console.error(
      `  Error: multiple users exist (${existing.join(", ")}). ` +
      `Pass --user=<slug> to init a new user.`
    );
    process.exit(1);
  }
  console.error(
    `  Error: multiple users exist on this machine. ` +
    `Specify --user=<slug>. Available: ${existing.join(", ")}`
  );
  process.exit(1);
}

function printBanner(): void {
  console.error(`
  ╦ ╦╔═╗╦═╗╔═╗╔═╗
  ║ ║╚═╗╠╦╝║  ╠═╝
  ╚═╝╚═╝╩╚═╚═╝╩   v0.1.0

  User Context Protocol — Local Ledger
  `);
}

/**
 * Get passphrase from:
 * 1. USRCP_PASSPHRASE environment variable (preferred — not visible in /proc/cmdline)
 * 2. --passphrase CLI flag (visible in process list — use only for init)
 * 3. undefined (dev mode)
 */
function getPassphrase(): string | undefined {
  // Prefer env var — not visible in /proc/<pid>/cmdline
  if (process.env.USRCP_PASSPHRASE) {
    const passphrase = process.env.USRCP_PASSPHRASE;
    // Clear from environment to reduce exposure window
    delete process.env.USRCP_PASSPHRASE;
    return passphrase;
  }

  // Fall back to CLI flag (warns about /proc visibility)
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--passphrase" && args[i + 1]) {
      console.error("  Warning: --passphrase is visible in process list. Prefer USRCP_PASSPHRASE env var.");
      return args[i + 1];
    }
    if (args[i].startsWith("--passphrase=")) {
      console.error("  Warning: --passphrase is visible in process list. Prefer USRCP_PASSPHRASE env var.");
      return args[i].split("=").slice(1).join("=");
    }
  }

  return undefined;
}

/**
 * Read a line of input from stdin, hiding typed characters (for passphrases).
 * Only invoked when stdin is a TTY — callers must check first.
 */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    let buf = "";
    const CODE_NL = 10;        // \n
    const CODE_CR = 13;        // \r
    const CODE_EOT = 4;        // Ctrl-D
    const CODE_ETX = 3;        // Ctrl-C
    const CODE_BS = 8;         // backspace
    const CODE_DEL = 127;      // delete
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
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
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

/**
 * Figure out init mode and (optionally) collect a passphrase.
 *
 * Resolution order:
 *   1. --dev flag → dev mode
 *   2. --passphrase / USRCP_PASSPHRASE → passphrase mode (non-interactive)
 *   3. TTY → interactive prompt (default answer: passphrase mode)
 *   4. Non-TTY with no signal → refuse with a clear error
 */
async function resolveInitMode(): Promise<{ mode: "dev" | "passphrase"; passphrase?: string }> {
  if (hasFlag("dev")) return { mode: "dev" };
  const explicit = getPassphrase();
  if (explicit) return { mode: "passphrase", passphrase: explicit };

  if (!process.stdin.isTTY) {
    console.error("  Error: no passphrase provided and stdin is not a TTY.");
    console.error("  Either pass --passphrase, set USRCP_PASSPHRASE, or pass --dev for dev mode.");
    process.exit(1);
  }

  const ans = (await readPlainLine("  Use passphrase mode (recommended)? [Y/n]: ")).trim().toLowerCase();
  if (ans === "n" || ans === "no") return { mode: "dev" };

  const p1 = await readHiddenLine("  Passphrase: ");
  if (!p1) {
    console.error("  Error: empty passphrase.");
    process.exit(1);
  }
  const p2 = await readHiddenLine("  Confirm:    ");
  if (p1 !== p2) {
    console.error("  Error: passphrases do not match.");
    process.exit(1);
  }
  return { mode: "passphrase", passphrase: p1 };
}

async function cmdInit(): Promise<void> {
  printBanner();

  // Auto-migrate old single-user layout into users/default/ on first run
  // of the new binary. No-op for already-migrated or fresh installs.
  const migration = migrateLegacyLayout();
  if (migration.migrated) {
    console.error(`  Migrated legacy files into users/default/: ${migration.movedPaths.join(", ")}`);
  }

  const slug = resolveUserSlug({ forInit: true });

  // Refuse to overwrite an existing user
  const existing = listUserSlugs();
  if (existing.includes(slug)) {
    console.error(`  Error: user "${slug}" already exists. Use --user=<other-slug> or pick a different name.`);
    process.exit(1);
  }

  const mode = await resolveInitMode();
  const passphrase = mode.passphrase;

  // Initialize master key first, then identity (which needs it for encryption)
  const masterKey = initializeMasterKey(passphrase);
  const identity = initializeIdentity(masterKey);
  const userDir = getUserDir();
  console.error(`  User slug: ${slug}`);
  console.error(`  User ID:   ${identity.user_id}`);
  console.error(`  Keys:      ${userDir}/keys/`);
  console.error(`  Ledger:    ${userDir}/ledger.db`);
  console.error(`  Mode:      ${passphrase ? "passphrase-protected" : "dev (key on disk)"}`);

  // Create the ledger DB (constructor handles migration)
  const ledger = new Ledger(undefined, passphrase);
  ledger.close();

  // Which MCP clients to register with. Default: claude.
  // Accept comma-separated list or "all" for every known client.
  const clientArg = getArg("client") ?? "claude";
  const clients: SupportedClient[] = resolveClients(clientArg);

  // Transport: stdio default (auto-spawn via MCP), http opt-in
  const transport = resolveTransport();
  if (transport === "http") {
    await ensureTlsCert();
    const { token } = ensureAuthToken();
    const portArg = getArg("port");
    const port = portArg ? parseInt(portArg, 10) : 9876;
    const url = `https://127.0.0.1:${port}/mcp`;
    console.error(`  TLS cert:  ${getUserDir()}/tls/{cert,key}.pem`);
    console.error(`  Auth:      ${getUserDir()}/auth.token`);
    console.error(`  URL:       ${url}`);
    for (const client of clients) {
      registerMcpServer(slug, { transport: "http", url, token, client });
    }
    console.error(`
  ⚠ HTTP transport: you must run the server yourself. Either:
    - \`usrcp serve --transport=http --user=${slug} --port=${port}\` in a shell, or
    - a background service (launchd/systemd).
  The MCP client will fail to connect until the server is running.
`);
  } else {
    for (const client of clients) {
      registerMcpServer(slug, { transport: "stdio", client });
    }
  }

  console.error(`
  ✓ USRCP local ledger initialized for user "${slug}".
  ${passphrase
    ? "  ⚠ Passphrase mode: set USRCP_PASSPHRASE env var before starting.\n    The key exists only in memory while the server runs."
    : "  Your AI agents now have persistent memory."
  }

  To start the MCP server manually:
    usrcp serve --user=${slug}

  Claude Code will auto-start it via MCP config.
  `);
}

/**
 * Supported MCP clients. Each has a known config file location.
 *   claude   — Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json etc.)
 *   cursor   — Cursor global MCP config (~/.cursor/mcp.json)
 *   continue — Continue.dev (~/.continue/mcpServers/usrcp.json via a per-server file; we write to the aggregate config)
 *   cline    — Cline VS Code extension (~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json)
 *
 * All four accept the same `mcpServers` schema (stdio `{command, args}` or http `{type, url, headers}`).
 */
export type SupportedClient = "claude" | "cursor" | "continue" | "cline";

export function getClientConfigPath(client: SupportedClient): string {
  const home = os.homedir();
  switch (client) {
    case "claude":
      switch (process.platform) {
        case "darwin":
          return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
        case "win32": {
          const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
          return path.join(appdata, "Claude", "claude_desktop_config.json");
        }
        default:
          return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
      }
    case "cursor":
      // Cursor reads ~/.cursor/mcp.json on all platforms.
      return path.join(home, ".cursor", "mcp.json");
    case "continue":
      // Continue.dev 0.9+ reads MCP servers from ~/.continue/config.json
      // under the `mcpServers` key. (Older versions used a YAML; we target
      // JSON to share schema with Claude/Cursor.)
      return path.join(home, ".continue", "config.json");
    case "cline":
      // Cline VS Code extension stores MCP config under VS Code's user
      // global storage. Path varies by platform — this is the macOS path.
      // Linux/Windows users may need to edit manually.
      if (process.platform === "darwin") {
        return path.join(
          home, "Library", "Application Support", "Code", "User", "globalStorage",
          "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"
        );
      }
      if (process.platform === "win32") {
        const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(
          appdata, "Code", "User", "globalStorage",
          "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"
        );
      }
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
        "Code", "User", "globalStorage",
        "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"
      );
  }
}

function registerMcpServer(
  slug: string,
  opts: { transport: "stdio" | "http"; url?: string; token?: string; client?: SupportedClient } = { transport: "stdio" }
): void {
  const client = opts.client ?? "claude";
  const mcpConfigPath = getClientConfigPath(client);
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });

  let config: Record<string, any> = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
    } catch {
      // If the file exists but is corrupt, don't overwrite — refuse and tell user
      console.error(`  Error: ${mcpConfigPath} exists but is not valid JSON.`);
      console.error(`  Fix it or move it aside, then re-run \`usrcp init\`.`);
      process.exit(1);
    }
  }

  // mcpServers is the Claude Desktop top-level key
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  // Per-user entry so agents can target a specific ledger
  const entryName = slug === "default" ? "usrcp" : `usrcp-${slug}`;
  const serverPath = path.resolve(__dirname, "index.js");

  let desired: Record<string, unknown>;
  if (opts.transport === "http") {
    if (!opts.url || !opts.token) {
      throw new Error("http transport requires url and token");
    }
    desired = {
      type: "http",
      url: opts.url,
      headers: { Authorization: `Bearer ${opts.token}` },
    };
  } else {
    desired = {
      command: "node",
      args: [serverPath, "serve", "--transport=stdio", `--user=${slug}`],
    };
  }

  const existing = config.mcpServers[entryName];
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    console.error(`  MCP:       "${entryName}" already registered in ${mcpConfigPath} — unchanged.`);
    return;
  }

  config.mcpServers[entryName] = desired;
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  console.error(
    existing
      ? `  MCP:       Updated "${entryName}" (${opts.transport}) in ${mcpConfigPath}`
      : `  MCP:       Registered "${entryName}" (${opts.transport}) in ${mcpConfigPath}`
  );
}

function cmdStatus(): void {
  printBanner();

  migrateLegacyLayout();
  resolveUserSlug();

  const identity = getIdentity();
  if (!identity) {
    console.error("  Not initialized. Run: usrcp init");
    process.exit(1);
  }

  const passphraseRequired = isPassphraseMode();
  const passphrase = passphraseRequired ? getPassphrase() : undefined;

  if (passphraseRequired && !passphrase) {
    console.error("  This ledger is passphrase-protected.");
    console.error("  Provide passphrase via --passphrase or USRCP_PASSPHRASE env var.");
    process.exit(1);
  }

  const ledger = new Ledger(undefined, passphrase);
  const stats = ledger.getStats();
  ledger.close();

  console.error(`  User ID:       ${identity.user_id}`);
  console.error(`  Created:       ${identity.created_at}`);
  console.error(`  Mode:          ${passphraseRequired ? "passphrase-protected" : "dev"}`);
  console.error(`  Key version:   ${stats.encryption_enabled ? "active" : "none"}`);
  console.error(`  Total Events:  ${stats.total_events}`);
  console.error(`  Total Projects:${stats.total_projects}`);
  console.error(`  Audit entries: ${stats.audit_log_entries}`);
  console.error(`  DB size:       ${(stats.db_size_bytes / 1024).toFixed(1)} KB`);
  console.error(`  Domains:       ${stats.domains.join(", ") || "(none)"}`);
  console.error(`  Platforms:     ${stats.platforms.join(", ") || "(none)"}`);
}

const KNOWN_CLIENTS: SupportedClient[] = ["claude", "cursor", "continue", "cline"];

function resolveClients(arg: string): SupportedClient[] {
  if (arg === "all") return [...KNOWN_CLIENTS];
  const names = arg.split(",").map((s) => s.trim()).filter(Boolean);
  const out: SupportedClient[] = [];
  for (const n of names) {
    if (!KNOWN_CLIENTS.includes(n as SupportedClient)) {
      console.error(`  Error: unknown --client value "${n}". Known: ${KNOWN_CLIENTS.join(", ")}, or "all".`);
      process.exit(1);
    }
    if (!out.includes(n as SupportedClient)) out.push(n as SupportedClient);
  }
  if (out.length === 0) {
    console.error(`  Error: --client cannot be empty.`);
    process.exit(1);
  }
  return out;
}

function resolveTransport(): "http" | "stdio" {
  const t = getArg("transport");
  if (t === undefined) return "stdio"; // default: stdio (backward-compat for MCP auto-spawn)
  if (t === "http" || t === "stdio") return t;
  console.error(`  Error: --transport must be "http" or "stdio", got "${t}"`);
  process.exit(1);
}

/**
 * Parse the per-process scope-enforcement flags:
 *   --scopes=<csv>      domain allowlist
 *   --readonly          strip mutating tools
 *   --no-audit          hide the audit-log tool
 *   --agent-id=<name>   logged with every call; required when --scopes is set
 *
 * Returns an empty options object when no flags are present, which preserves
 * the pre-flag behavior of `usrcp serve` (full access, all tools).
 */
function resolveServeOptions(): ServeOptions {
  const opts: ServeOptions = {};

  const scopesArg = getArg("scopes");
  if (scopesArg !== undefined) {
    const parsed = scopesArg
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parsed.length === 0) {
      console.error(`  Error: --scopes was given but is empty. Pass a comma-separated domain list, e.g. --scopes=coding,personal.`);
      process.exit(1);
    }
    for (const s of parsed) {
      if (s.length > 100) {
        console.error(`  Error: scope "${s.slice(0, 20)}..." exceeds 100 chars.`);
        process.exit(1);
      }
    }
    opts.scopes = parsed;
  }

  if (hasFlag("readonly")) opts.readonly = true;
  if (hasFlag("no-audit")) opts.noAudit = true;

  const agentId = getArg("agent-id");
  if (agentId !== undefined) {
    if (agentId.length === 0 || agentId.length > 100) {
      console.error(`  Error: --agent-id must be 1-100 chars.`);
      process.exit(1);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) {
      console.error(`  Error: --agent-id may only contain letters, numbers, dot, underscore, dash.`);
      process.exit(1);
    }
    opts.agentId = agentId;
  }

  // Agents must be identifiable when scope is enforced — otherwise the
  // per-call audit row carries no useful attribution.
  if (opts.scopes && !opts.agentId) {
    console.error(`  Error: --scopes requires --agent-id=<name> for audit attribution.`);
    process.exit(1);
  }

  return opts;
}

/** One-line banner appended to the serve startup messages when any scope flag is set. */
function formatScopeBanner(o: ServeOptions): string {
  const flags: string[] = [];
  if (o.scopes) flags.push(`scopes=[${o.scopes.join(",")}]`);
  if (o.readonly) flags.push("readonly");
  if (o.noAudit) flags.push("no-audit");
  if (!o.agentId && flags.length === 0) return "";
  const tail = flags.length > 0 ? " " + flags.join(" ") : "";
  return ` agent=${o.agentId ?? "unidentified"}${tail}`;
}

async function cmdServe(): Promise<void> {
  // Identity init happens inside Ledger constructor if needed
  migrateLegacyLayout();
  resolveUserSlug();

  const passphraseRequired = isPassphraseMode();
  const passphrase = passphraseRequired ? getPassphrase() : undefined;

  if (passphraseRequired && !passphrase) {
    console.error("[usrcp] This ledger is passphrase-protected.");
    console.error("[usrcp] Set USRCP_PASSPHRASE env var to unlock.");
    process.exit(1);
  }

  const transport = resolveTransport();
  const serveOpts = resolveServeOptions();
  const { server, shutdown } = createServer(passphrase, serveOpts);

  const scopeBanner = formatScopeBanner(serveOpts);

  if (transport === "stdio") {
    const stdio = new StdioServerTransport();
    const handleShutdown = () => {
      console.error("[usrcp] Shutting down...");
      shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", handleShutdown);
    process.on("SIGINT", handleShutdown);
    await server.connect(stdio);
    console.error(`[usrcp] MCP server running on stdio (${passphraseRequired ? "passphrase mode" : "dev mode"})${scopeBanner}`);
    return;
  }

  // HTTP transport
  const portArg = getArg("port");
  const port = portArg ? parseInt(portArg, 10) : 0; // 0 = ephemeral
  if (portArg && (!Number.isFinite(port) || port < 0 || port > 65535)) {
    console.error(`  Error: --port must be 0-65535, got "${portArg}"`);
    process.exit(1);
  }

  const handle = await startHttpTransport(server, { port });
  const handleShutdown = async () => {
    console.error("[usrcp] Shutting down...");
    try { await handle.close(); } catch { /* ignore */ }
    shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);

  console.error(`[usrcp] MCP server running on ${handle.url}`);
  console.error(`[usrcp] Bearer token: ${handle.token.slice(0, 8)}... (see ~/.usrcp/users/*/auth.token)`);
  console.error(`[usrcp] TLS cert:     ~/.usrcp/users/*/tls/cert.pem (self-signed, localhost only)`);
  console.error(`[usrcp] Mode:         ${passphraseRequired ? "passphrase" : "dev"}${scopeBanner}`);
}

async function cmdSync(subcommand: string | undefined): Promise<void> {
  migrateLegacyLayout();
  resolveUserSlug();
  const passphrase = isPassphraseMode() ? getPassphrase() : undefined;

  switch (subcommand) {
    case "status": {
      const s = syncStatus({ passphrase });
      console.error(`  cloud_endpoint:           ${s.cloud_endpoint ?? "(unset)"}`);
      console.error(`  local_max_seq:            ${s.local_max_seq}`);
      console.error(`  last_push_local_seq:      ${s.last_push_local_seq}`);
      console.error(`  last_pull_remote_cursor:  ${s.last_pull_remote_cursor}`);
      console.error(`  pending_events_to_push:   ${s.pending_events_to_push}`);
      console.error(`  last_sync_at:             ${s.last_sync_at ?? "(never)"}`);
      return;
    }
    case "push": {
      const r = await syncPush({ passphrase });
      console.error(`  Pushed ${r.pushed} event(s); local cursor now ${r.cursor}.`);
      return;
    }
    case "pull": {
      const r = await syncPull({ passphrase });
      console.error(`  Pulled ${r.pulled} event(s), applied ${r.applied}; remote cursor now ${r.cursor}.`);
      return;
    }
    default:
      console.error("  Usage: usrcp sync <push|pull|status>");
      process.exit(1);
  }
}

function cmdConfig(args: string[]): void {
  migrateLegacyLayout();
  resolveUserSlug();
  const [action, key, value] = args;
  if (action === "get") {
    const cfg = readConfig();
    if (!key) {
      console.error(JSON.stringify(cfg, null, 2));
      return;
    }
    console.error(String((cfg as any)[key] ?? ""));
    return;
  }
  if (action === "set") {
    if (!key || value === undefined) {
      console.error("  Usage: usrcp config set <key> <value>");
      process.exit(1);
    }
    if (key !== "cloud_endpoint") {
      console.error(`  Error: only "cloud_endpoint" is user-settable in Phase 1. Other fields are managed by \`usrcp sync\`.`);
      process.exit(1);
    }
    updateConfig({ cloud_endpoint: value });
    console.error(`  Set ${key} = ${value}`);
    return;
  }
  console.error("  Usage: usrcp config <get|set> [key] [value]");
  process.exit(1);
}

async function cmdAdapter(args: string[]): Promise<void> {
  // usrcp adapter <subcommand> [subcommand-args...]
  // Subcommands:
  //   add terminal --targets=<list>|--all
  //   remove terminal --targets=<list>
  //   list
  //   terminal refresh-context

  const sub = args[0];

  if (sub === "list") {
    const rows = await listTerminalAdapters();
    console.error("  Terminal adapter status:");
    for (const { target, status } of rows) {
      const icon = status === "registered" ? "✓" : status === "not_registered" ? "✗" : "?";
      console.error(`    ${icon}  ${target.padEnd(14)} ${status}`);
    }
    return;
  }

  if (sub === "terminal" && args[1] === "refresh-context") {
    // usrcp adapter terminal refresh-context
    const passphraseArg = getArg("passphrase") ?? process.env.USRCP_PASSPHRASE;
    const userSlug = getArg("user");
    const outPath = await refreshContextMd({ passphrase: passphraseArg, userSlug });
    console.error(`  CONTEXT.md written to ${outPath}`);
    return;
  }

  if (sub === "add" && args[1] === "terminal") {
    const usrcpBin = resolveUsrcpBin();
    let targets: TargetName[];
    if (hasFlag("all")) {
      targets = detectInstalledTargets();
      if (targets.length === 0) {
        console.error("  No supported terminal agents detected on this machine.");
        console.error(`  Specify targets explicitly: usrcp adapter add terminal --targets=<list>`);
        console.error(`  Known targets: ${ALL_TARGETS.join(", ")}`);
        return;
      }
      console.error(`  Auto-detected: ${targets.join(", ")}`);
    } else {
      const raw = getArg("targets");
      if (!raw) {
        console.error("  Error: --targets=<list> or --all required");
        console.error(`  Known targets: ${ALL_TARGETS.join(", ")}`);
        process.exit(1);
      }
      const parsed = parseTargets(raw);
      if (!parsed) process.exit(1);
      targets = parsed;
    }

    const results = await addTerminalAdapter(targets, usrcpBin);
    let anyFailed = false;
    for (const r of results) {
      if (r.ok) {
        console.error(`  ✓  ${r.target}: registered${r.path ? ` (${r.path})` : ""}`);
      } else {
        console.error(`  ✗  ${r.target}: ${r.error}`);
        anyFailed = true;
      }
    }
    console.error("");
    console.error("  Restart your terminal session for changes to take effect.");
    if (anyFailed) process.exit(1);
    return;
  }

  if (sub === "remove" && args[1] === "terminal") {
    const raw = getArg("targets");
    if (!raw) {
      console.error("  Error: --targets=<list> required");
      console.error(`  Known targets: ${ALL_TARGETS.join(", ")}`);
      process.exit(1);
    }
    const parsed = parseTargets(raw);
    if (!parsed) process.exit(1);

    const results = await removeTerminalAdapter(parsed);
    let anyFailed = false;
    for (const r of results) {
      if (r.ok) {
        console.error(`  ✓  ${r.target}: unregistered`);
      } else {
        console.error(`  ✗  ${r.target}: ${r.error}`);
        anyFailed = true;
      }
    }
    console.error("");
    console.error("  Restart your terminal session for changes to take effect.");
    if (anyFailed) process.exit(1);
    return;
  }

  // Unrecognised subcommand — print usage.
  console.error(`  Usage: usrcp adapter <subcommand> [options]

  Subcommands:
    add terminal --targets=<list>   Register USRCP with specific agents
    add terminal --all              Auto-detect installed agents and register
    remove terminal --targets=<list> Unregister USRCP from specific agents
    list                            Show registration status for all targets
    terminal refresh-context        Regenerate ~/.usrcp/CONTEXT.md from ledger

  Targets: ${ALL_TARGETS.join(", ")}
  `);
  process.exit(1);
}

// --- CLI Router ---
const command = process.argv[2];

switch (command) {
  case "init":
    cmdInit().catch((err) => {
      console.error("[usrcp] Fatal:", err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    });
    break;
  case "serve":
    cmdServe().catch((err) => {
      console.error("[usrcp-local] Fatal:", err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    });
    break;
  case "status":
    cmdStatus();
    break;
  case "users":
    migrateLegacyLayout();
    {
      const slugs = listUserSlugs();
      if (slugs.length === 0) {
        console.error("  No users. Run: usrcp init");
      } else {
        console.error(`  Users in ${getUsrcpBaseDir()}/users/:`);
        for (const s of slugs) console.error(`    - ${s}`);
      }
    }
    break;
  case "sync":
    cmdSync(process.argv[3]).catch((err) => {
      console.error("[usrcp sync] Error:", err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    });
    break;
  case "config":
    cmdConfig(process.argv.slice(3));
    break;
  case "adapter":
    cmdAdapter(process.argv.slice(3)).catch((err) => {
      console.error("[usrcp adapter] Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "setup":
    runSetup({ adapter: getArg("adapter") }).catch((err) => {
      console.error("[usrcp setup] Fatal:", err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    });
    break;
  default:
    if (!command) {
      cmdServe().catch((err) => {
        console.error("[usrcp-local] Fatal:", err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      });
    } else {
      printBanner();
      console.error(`  Usage: usrcp <command> [options]

  Commands:
    setup            Guided setup wizard — configure ledger + adapters in one flow
    init             Initialize local ledger and register MCP server
    serve            Start MCP server on stdio (or HTTPS with --transport=http)
    status           Show ledger status and statistics
    users            List user slugs on this machine
    config <op>      get / set — manage per-user config (e.g., cloud_endpoint)
    sync <op>        push / pull / status — hosted ledger synchronization
    adapter <op>     add/remove/list terminal MCP registration for CLI agents

  Options:
    --user <slug>           User slug (default: "default"; required if >1 user exists)
    --client <name>         Which MCP client to register with. One or more of:
                            claude (default), cursor, continue, cline.
                            Comma-separated or "all" — e.g., --client=claude,cursor
    --transport <mode>      stdio (default) or http
    --passphrase <value>    Passphrase for encryption key derivation
                            Or set USRCP_PASSPHRASE environment variable

  serve scope-enforcement (per-process; for restricting one agent's access):
    --scopes=<csv>          Domain allowlist (e.g. coding,personal). Tools that
                            target other domains are refused with OUT_OF_SCOPE.
    --readonly              Drop mutating tools (append, update, rotate, set_fact).
    --no-audit              Hide usrcp_audit_log so the agent can't read history.
    --agent-id=<name>       Logged with every tool call. Required when --scopes
                            is set. Default unflagged: full access, no agent ID.

  Multi-user:
    usrcp init --user=frank
    usrcp init --user=jess
    usrcp serve --user=frank

  Passphrase mode:
    usrcp init --passphrase "my secret phrase"
    USRCP_PASSPHRASE="my secret phrase" usrcp serve

  Scoped agent example:
    usrcp serve --agent-id=cursor-coding --scopes=coding --readonly --no-audit
    # Generate the matching MCP config snippet:
    usrcp setup --adapter=mcp-agent
  `);
    }
}
