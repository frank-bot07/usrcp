#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  initializeMasterKey,
  getUserDir,
} from "usrcp-local/encryption";
import { Ledger } from "usrcp-local/ledger";
import { createStreamServer } from "./server.js";
import { openStreamDb, closeStreamDb } from "./db/index.js";
import { loadVectorExtension } from "./vector/index.js";
import { pingOllama } from "./embeddings/ollama.js";
import {
  loadConfig,
  saveConfig,
  configPath,
  type StreamConfig,
} from "./config-io.js";
import {
  syncStreamPush,
  syncStreamPull,
  syncStreamStatus,
} from "./sync.js";

function hasFlag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}`);
}

function getArg(name: string): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(`--${name}=`))
      return args[i].split("=").slice(1).join("=");
  }
  return undefined;
}

function getPassphrase(): string | undefined {
  if (process.env.USRCP_PASSPHRASE) {
    const p = process.env.USRCP_PASSPHRASE;
    delete process.env.USRCP_PASSPHRASE;
    return p;
  }
  const fromArg = getArg("passphrase");
  if (fromArg) {
    console.error(
      "[usrcp-stream] Warning: --passphrase is visible in the process list. Prefer USRCP_PASSPHRASE env var."
    );
    return fromArg;
  }
  return undefined;
}

async function cmdInit(): Promise<number> {
  // @inquirer/prompts v8 is ESM-only; we're CJS so it has to be lazy-imported.
  const { input, select, confirm, password } = await import("@inquirer/prompts");

  const explicit = getArg("embedding-provider") as
    | "ollama"
    | "openai"
    | "voyage"
    | undefined;

  console.error("[usrcp-stream] init: configuring embedding provider.\n");

  const provider: "ollama" | "openai" | "voyage" =
    explicit ??
    (await select({
      message: "Choose an embedding provider:",
      default: "ollama",
      choices: [
        { name: "Ollama (local, default)", value: "ollama" },
        { name: "OpenAI (sends plaintext to OpenAI)", value: "openai" },
        { name: "Voyage AI (sends plaintext to Voyage)", value: "voyage" },
      ],
    }));

  const config: StreamConfig = { embedding: { provider } };

  if (provider === "ollama") {
    const reachable = await pingOllama();
    if (!reachable) {
      console.error(
        "[usrcp-stream] Ollama is not reachable at http://localhost:11434.\n" +
          "  Start it (`ollama serve`) and pull a model (`ollama pull nomic-embed-text`) first."
      );
      return 1;
    }
    const model = await input({
      message: "Model:",
      default: "nomic-embed-text",
    });
    config.embedding.model = model;
    config.embedding.host = "http://localhost:11434";
  } else {
    const consent = await confirm({
      message:
        `WARNING: with provider=${provider}, plaintext message content is sent to ${provider} for embedding. ` +
        `This leaves your machine. Continue?`,
      default: false,
    });
    if (!consent) {
      console.error("[usrcp-stream] aborted - no consent for vendor provider.");
      return 1;
    }
    config.embedding.vendor_consent = true;
    const apiKey = await password({ message: `${provider} API key:` });
    if (!apiKey) {
      console.error("[usrcp-stream] aborted - no API key supplied.");
      return 1;
    }
    // The API key is stored INSIDE the encrypted config file (everything
    // we write here goes through encrypt() with stream-config domain).
    (config as unknown as Record<string, unknown>)._api_key = apiKey;
  }

  const passphrase = getPassphrase();
  const masterKey = initializeMasterKey(passphrase);
  const userDir = getUserDir();
  saveConfig(masterKey, userDir, config);
  console.error(`[usrcp-stream] config written to ${configPath(userDir)}`);
  return 0;
}

async function cmdServe(): Promise<number> {
  const passphrase = getPassphrase();

  // Symmetric (legacy) + asymmetric (PR #61) scope flags.
  // `createStreamServer` -> registerStreamTools -> resolveStreamScopes
  // rejects mixing --scopes with --read-scopes/--write-scopes, so we
  // don't need to duplicate that check at the CLI layer.
  const scopes = getArg("scopes")?.split(",").filter(Boolean);
  const readScopes = getArg("read-scopes")?.split(",").filter(Boolean);
  const writeScopes = getArg("write-scopes")?.split(",").filter(Boolean);
  const readonly = hasFlag("readonly");
  const noAudit = hasFlag("no-audit");
  const agentId = getArg("agent-id");

  const { server, shutdown } = createStreamServer(passphrase, {
    scopes,
    readScopes,
    writeScopes,
    readonly,
    noAudit,
    agentId,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const onExit = () => {
    try {
      shutdown();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  return new Promise<number>(() => {
    // Server runs until signal handler exits the process.
  });
}

async function cmdStatus(): Promise<number> {
  const passphrase = getPassphrase();
  const masterKey = initializeMasterKey(passphrase);
  const userDir = getUserDir();
  const handle = openStreamDb(userDir, masterKey);

  const events = handle.db.prepare("SELECT COUNT(*) as c FROM events").get() as {
    c: number;
  };
  const threads = handle.db
    .prepare("SELECT COUNT(*) as c FROM threads")
    .get() as { c: number };
  const surfaces = handle.db
    .prepare("SELECT COUNT(*) as c FROM surface_state")
    .get() as { c: number };
  const last = handle.db.prepare("SELECT MAX(ts_ms) as t FROM events").get() as {
    t: number | null;
  };

  let config: StreamConfig | null = null;
  try {
    config = loadConfig(masterKey, userDir);
  } catch {
    // ignored - partial config or first run
  }

  const out = {
    user_dir: userDir,
    event_count: events.c,
    thread_count: threads.c,
    surface_count: surfaces.c,
    last_capture_ms: last.t,
    last_capture_iso: last.t ? new Date(last.t).toISOString() : null,
    embedding_provider: config?.embedding.provider ?? "(not configured)",
    embedding_model: config?.embedding.model ?? null,
  };
  console.log(JSON.stringify(out, null, 2));

  closeStreamDb(handle);
  return 0;
}

function usage(): void {
  console.error(`Usage: usrcp-stream <command>

Commands:
  init                 Configure embedding provider and write stream-config.toml
  serve                Run the MCP server over stdio
  status               Print event/thread/surface counts
  sync push            Push local events (+ embeddings) to a usrcp-cloud endpoint
  sync pull            Pull events from the cloud and re-stitch threads locally
  sync status          Report sync cursor positions and pending-to-push count

Common flags:
  --user=<slug>         User slug to operate on (default: "default")
  --passphrase=<p>      Passphrase mode (prefer USRCP_PASSPHRASE env var)
  --scopes=a,b,c        (serve) Symmetric: restrict reads AND writes to
                                 listed surfaces (legacy; mutex with the
                                 asymmetric pair below)
  --read-scopes=a,b,c   (serve) Asymmetric: read allowlist. Alone, implies
                                 "no writes" (writeScopes defaults to []).
  --write-scopes=a,b,c  (serve) Asymmetric: write allowlist. Alone, leaves
                                 reads unrestricted. Must be a subset of
                                 read-scopes when both are set.
  --readonly            (serve) Strip stream_capture
  --no-audit            (serve) Suppress per-call audit log writes
  --agent-id=<id>       (serve) Identifier logged with every call

Init flags:
  --embedding-provider=<ollama|openai|voyage>   Skip the interactive prompt

Sync flags:
  --endpoint=<url>      Cloud endpoint URL (required for push/pull)
  --limit=<N>           Batch size (default 200, max 500)
`);
}

async function cmdSync(subcommand: string | undefined): Promise<number> {
  if (subcommand !== "push" && subcommand !== "pull" && subcommand !== "status") {
    console.error(
      "[usrcp-stream] sync subcommand must be one of: push, pull, status"
    );
    return 1;
  }

  const endpoint = getArg("endpoint");
  if (!endpoint && subcommand !== "status") {
    console.error(
      "[usrcp-stream] sync requires --endpoint=<url> (or future: cloud_endpoint in stream-config.toml)"
    );
    return 1;
  }

  const limit = getArg("limit") ? Number(getArg("limit")) : undefined;
  const passphrase = getPassphrase();
  const masterKey = initializeMasterKey(passphrase);
  const userDir = getUserDir();
  const ledger = new Ledger(undefined, passphrase);
  const handle = openStreamDb(userDir, masterKey);
  try {
    loadVectorExtension(handle.db);
  } catch (err) {
    console.error(
      "[usrcp-stream] sqlite-vec failed to load; pull will not re-index vectors",
      err
    );
  }

  try {
    let result: unknown;
    if (subcommand === "push") {
      result = await syncStreamPush(handle, ledger, { endpoint, limit });
    } else if (subcommand === "pull") {
      result = await syncStreamPull(handle, ledger, { endpoint, limit });
    } else {
      result = syncStreamStatus(handle, { endpoint });
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    console.error(
      `[usrcp-stream] sync ${subcommand} failed:`,
      err instanceof Error ? err.message : err
    );
    return 1;
  } finally {
    closeStreamDb(handle);
    try {
      ledger.close();
    } catch {
      // ignore
    }
  }
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "init":
      return cmdInit();
    case "serve":
      return cmdServe();
    case "status":
      return cmdStatus();
    case "sync":
      return cmdSync(process.argv[3]);
    case undefined:
    case "--help":
    case "-h":
      usage();
      return cmd === undefined ? 1 : 0;
    default:
      console.error(`[usrcp-stream] Unknown command: ${cmd}`);
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[usrcp-stream] Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
