#!/usr/bin/env node
/**
 * USRCP Obsidian adapter entry point.
 *
 *   usrcp-obsidian                   # load config, start the vault watcher
 *   usrcp-obsidian --reset-config    # re-run 'usrcp setup --adapter=obsidian'
 *
 * Capture-only (v0): file-system watcher on the configured vault using
 * chokidar. On each `add` or `change` event, the file is read, parsed,
 * filtered, and written to the ledger via the same `appendEvent` path
 * the chat adapters use.
 *
 * Why per-file debounce: Obsidian writes the file many times during a
 * single edit session. Without coalescing we'd flood the ledger with
 * near-identical events. The debounce window holds events until the file
 * has been quiet for `debounce_ms`, then captures the latest content.
 *
 * Why awaitWriteFinish in chokidar: Obsidian (and many editors) write
 * incrementally — emitting events while the file is mid-write yields
 * truncated reads. awaitWriteFinish waits for two consecutive stat()
 * calls to show the same size before emitting.
 *
 * The watcher requires USRCP_PASSPHRASE if the local ledger is
 * passphrase-protected, same as every other adapter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { loadConfig } from "./config.js";
import { parseNote } from "./parse.js";
import { captureNote } from "./capture.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function processFile(
  ledger: Ledger,
  vaultPath: string,
  absPath: string,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    console.error(`[usrcp-obsidian] read failed for ${absPath}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const relPath = path.relative(vaultPath, absPath);
  const note = parseNote(raw, relPath);
  try {
    const outcome = await captureNote(ledger, note, relPath, raw, config);
    if (outcome.captured) {
      console.error(
        `[usrcp-obsidian] captured ${relPath} → event ${outcome.event_id} ` +
        `(seq ${outcome.ledger_sequence}${outcome.duplicate ? ", duplicate" : ""})`
      );
    } else {
      // Keep skip logs at debug-ish volume; they're useful but not the
      // main signal. Print one short line per skip so users can tell
      // their filters are doing what they expect.
      console.error(`[usrcp-obsidian] skipped ${relPath}: ${outcome.reason}`);
    }
  } catch (err) {
    console.error(`[usrcp-obsidian] capture error for ${relPath}: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  if (hasFlag("reset-config")) {
    console.error("[usrcp-obsidian] --reset-config: launching 'usrcp setup --adapter=obsidian'...");
    try {
      execSync("usrcp setup --adapter=obsidian", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  const config = loadConfig();
  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);

  // Lazy-load chokidar so the watcher doesn't pay its startup cost during
  // unit tests that import other modules from this package.
  const { default: chokidar } = await import("chokidar");

  // Per-file debounce timers: collapse a burst of writes into one capture.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let processing = false;

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await processFile(ledger, config.vault_path, next, config);
      }
    } finally {
      processing = false;
    }
  }

  function schedule(absPath: string) {
    const prev = pending.get(absPath);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pending.delete(absPath);
      // Coalesce duplicate enqueues — if the same path is already queued
      // (rare under normal debounce, possible under contention) skip it.
      if (!queue.includes(absPath)) queue.push(absPath);
      void drain();
    }, config.debounce_ms);
    pending.set(absPath, timer);
  }

  const watcher = chokidar.watch(config.vault_path, {
    ignored: (file: string) => {
      const base = path.basename(file);
      // Skip Obsidian's metadata dir and any dotfiles.
      if (base === ".obsidian" || base === ".trash" || base === ".git") return true;
      // Only watch markdown files (chokidar passes both files and dirs through ignored).
      // Allow directories so traversal continues.
      try {
        if (fs.statSync(file).isDirectory()) return false;
      } catch {
        return false;
      }
      return !file.endsWith(".md");
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  console.error(`[usrcp-obsidian] watching ${config.vault_path}`);
  console.error(`[usrcp-obsidian] domain=${config.domain} debounce=${config.debounce_ms}ms`);
  if (config.allowed_subdirs?.length) {
    console.error(`[usrcp-obsidian] allowed subdirs: ${config.allowed_subdirs.join(", ")}`);
  }
  if (config.excluded_subdirs?.length) {
    console.error(`[usrcp-obsidian] excluded subdirs: ${config.excluded_subdirs.join(", ")}`);
  }

  watcher.on("add", (p: string) => schedule(p));
  watcher.on("change", (p: string) => schedule(p));
  watcher.on("error", (err: unknown) => {
    console.error(`[usrcp-obsidian] watcher error: ${err instanceof Error ? err.message : err}`);
  });

  const shutdown = (signal: string) => {
    console.error(`[usrcp-obsidian] ${signal} received, shutting down.`);
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    void watcher.close();
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[usrcp-obsidian] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
