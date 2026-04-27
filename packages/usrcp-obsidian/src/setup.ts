/**
 * Interactive setup wizard for the USRCP Obsidian adapter.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=obsidian`).
 * Walks the user through: vault path → subdir filters → tag filters →
 * domain → debounce. Capture-only — no Anthropic key needed.
 *
 * Exports:
 *   runObsidianSetup() — full interactive flow; writes obsidian-config.json;
 *                        returns the persisted ObsidianConfig.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeObsidianConfig,
  readPartialConfig,
  type ObsidianConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Minimal prompt helpers — same shape as iMessage's setup.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Vault detection helpers
// ---------------------------------------------------------------------------

/**
 * Look in common parent dirs for directories that contain `.obsidian/`.
 * Returns at most a handful of candidates so the prompt stays readable.
 */
function detectVaultCandidates(): string[] {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, "Documents"),
    path.join(home, "Notes"),
    path.join(home, "Obsidian"),
    path.join(home, "Vaults"),
  ].filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  const found: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = path.join(root, e.name);
      try {
        if (fs.statSync(path.join(candidate, ".obsidian")).isDirectory()) {
          found.push(candidate);
          if (found.length >= 8) return found;
        }
      } catch { /* not a vault */ }
    }
  }
  return found;
}

function isLikelyVault(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && fs.statSync(path.join(p, ".obsidian")).isDirectory();
  } catch {
    return false;
  }
}

/** Top-level subdirs of the vault, excluding hidden/Obsidian-internal dirs. */
function listTopLevelSubdirs(vaultPath: string): string[] {
  try {
    return fs
      .readdirSync(vaultPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "_attachments")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function parseIndices(raw: string, max: number): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.toLowerCase() === "all") {
    return Array.from({ length: max }, (_, i) => i);
  }
  return trimmed
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((n) => !isNaN(n) && n >= 0 && n < max);
}

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

export async function runObsidianSetup(): Promise<ObsidianConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-obsidian setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  const existing = readPartialConfig();

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Obsidian adapter setup ───────────────────────────────────┐\n");
  process.stderr.write("  │ Watches a local Obsidian vault and captures note edits      │\n");
  process.stderr.write("  │ into your USRCP ledger. v0: capture-only (no replies).      │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/obsidian-config.json (mode 0600)   │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Step 1 — Vault path ────────────────────────────────────────────────
  process.stderr.write("  Step 1 — Vault path\n");
  process.stderr.write("  ────────────────────\n");

  let vault_path = "";
  const candidates = detectVaultCandidates();
  if (candidates.length > 0) {
    process.stderr.write(`  Detected ${candidates.length} possible vault${candidates.length === 1 ? "" : "s"}:\n`);
    candidates.forEach((c, i) => process.stderr.write(`    [${i + 1}] ${c}\n`));
    process.stderr.write("    [m] Type a path manually\n\n");

    while (true) {
      const raw = await readPlainLine(
        `  Pick one (number) or 'm' (${existing.vault_path ? `Enter for existing: ${existing.vault_path}` : "default 1"}):\n  > `
      );
      const trimmed = raw.trim();
      if (!trimmed && existing.vault_path) {
        if (isLikelyVault(existing.vault_path)) {
          vault_path = existing.vault_path;
          break;
        }
        process.stderr.write(`  Existing path no longer looks like a vault: ${existing.vault_path}\n`);
        continue;
      }
      if (!trimmed) {
        vault_path = candidates[0];
        break;
      }
      if (trimmed.toLowerCase() === "m") {
        const manual = (await readPlainLine("  Vault path:\n  > ")).trim();
        if (!manual) {
          process.stderr.write("  Path cannot be empty.\n");
          continue;
        }
        const expanded = manual.replace(/^~(?=\/|$)/, os.homedir());
        if (!isLikelyVault(expanded)) {
          process.stderr.write(`  ${expanded} doesn't look like an Obsidian vault (no .obsidian/ subdir).\n`);
          const confirm = await readYN("  Use it anyway?", false);
          if (!confirm) continue;
        }
        vault_path = expanded;
        break;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
        process.stderr.write(`  Pick 1..${candidates.length} or 'm'.\n`);
        continue;
      }
      vault_path = candidates[idx];
      break;
    }
  } else {
    while (true) {
      const raw = await readPlainLine(
        `  Path to your vault${existing.vault_path ? ` (Enter for existing: ${existing.vault_path})` : ""}:\n  > `
      );
      const trimmed = raw.trim();
      if (!trimmed && existing.vault_path) {
        vault_path = existing.vault_path;
        break;
      }
      if (!trimmed) {
        process.stderr.write("  Path cannot be empty.\n");
        continue;
      }
      const expanded = trimmed.replace(/^~(?=\/|$)/, os.homedir());
      if (!isLikelyVault(expanded)) {
        process.stderr.write(`  ${expanded} doesn't look like an Obsidian vault (no .obsidian/ subdir).\n`);
        const confirm = await readYN("  Use it anyway?", false);
        if (!confirm) continue;
      }
      vault_path = expanded;
      break;
    }
  }

  process.stderr.write(`  ✓ Vault: ${vault_path}\n\n`);

  // ── Step 2 — Allowed subdirs ────────────────────────────────────────────
  process.stderr.write("  Step 2 — Which folders to capture from\n");
  process.stderr.write("  ────────────────────────────────────────\n");

  const subdirs = listTopLevelSubdirs(vault_path);
  let allowed_subdirs: string[] | undefined;

  if (subdirs.length === 0) {
    process.stderr.write("  Vault has no subdirectories. Capturing from root.\n\n");
  } else {
    process.stderr.write("  Top-level folders:\n");
    subdirs.forEach((d, i) => process.stderr.write(`    [${i + 1}] ${d}\n`));
    process.stderr.write(`    [${subdirs.length + 1}] (vault root, *.md at top level)\n\n`);

    const raw = await readPlainLine(
      "  Numbers to allowlist (comma-separated), 'all', or Enter for all:\n  > "
    );
    const indices = parseIndices(raw, subdirs.length + 1);
    if (indices.length === 0) {
      // empty input or 'all' → no allowlist (capture everywhere)
      allowed_subdirs = undefined;
      process.stderr.write("  ✓ Capturing from anywhere in the vault.\n\n");
    } else {
      allowed_subdirs = indices.map((i) => (i === subdirs.length ? "" : subdirs[i]));
      const display = allowed_subdirs.map((s) => (s === "" ? "(root)" : s)).join(", ");
      process.stderr.write(`  ✓ Allowlist: ${display}\n\n`);
    }
  }

  // ── Step 3 — Excluded subdirs ───────────────────────────────────────────
  let excluded_subdirs: string[] | undefined;
  if (subdirs.length > 0) {
    process.stderr.write("  Step 3 — Folders to skip (private/drafts)\n");
    process.stderr.write("  ──────────────────────────────────────────\n");
    const skipRaw = await readPlainLine(
      "  Folder names to exclude, comma-separated (Enter to skip):\n  > "
    );
    const trimmed = skipRaw.trim();
    if (trimmed) {
      excluded_subdirs = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      process.stderr.write(`  ✓ Excluded: ${excluded_subdirs.join(", ")}\n\n`);
    } else {
      process.stderr.write("  (none)\n\n");
    }
  }

  // ── Step 4 — Tag filters (optional) ─────────────────────────────────────
  process.stderr.write("  Step 4 — Tag filters (optional, advanced)\n");
  process.stderr.write("  ──────────────────────────────────────────\n");
  process.stderr.write("  Restrict capture to notes with specific #tags, or skip notes with #tags.\n");
  process.stderr.write("  (Most users skip this and use folder filters instead.)\n\n");

  let allowed_tags: string[] | undefined;
  let excluded_tags: string[] | undefined;
  const useTags = await readYN("  Configure tag filters?", false);
  if (useTags) {
    const allowRaw = await readPlainLine("  Allowed tags (comma-separated, no '#'; Enter to skip):\n  > ");
    if (allowRaw.trim()) {
      allowed_tags = allowRaw.split(",").map((s) => s.trim().replace(/^#/, "")).filter((s) => s.length > 0);
    }
    const excludeRaw = await readPlainLine("  Excluded tags (comma-separated, no '#'; Enter to skip):\n  > ");
    if (excludeRaw.trim()) {
      excluded_tags = excludeRaw.split(",").map((s) => s.trim().replace(/^#/, "")).filter((s) => s.length > 0);
    }
    if (allowed_tags?.length) process.stderr.write(`  ✓ Allowed tags: ${allowed_tags.join(", ")}\n`);
    if (excluded_tags?.length) process.stderr.write(`  ✓ Excluded tags: ${excluded_tags.join(", ")}\n`);
    process.stderr.write("\n");
  } else {
    process.stderr.write("  (skipped)\n\n");
  }

  // ── Step 5 — Domain ──────────────────────────────────────────────────────
  process.stderr.write("  Step 5 — USRCP domain name\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Events from this adapter are written under this domain.\n");
  process.stderr.write("  Use 'obsidian' for general notes, or 'personal' / 'work' to merge with other surfaces.\n\n");
  const defaultDomain = existing.domain ?? "obsidian";
  let domain = "";
  while (true) {
    const raw = await readPlainLine(`  Domain (Enter for "${defaultDomain}"):\n  > `);
    const trimmed = raw.trim();
    if (!trimmed) { domain = defaultDomain; break; }
    if (!/^[a-z0-9_-]{1,40}$/.test(trimmed)) {
      process.stderr.write("  Use 1-40 chars, lowercase letters/digits/underscore/dash only.\n");
      continue;
    }
    domain = trimmed;
    break;
  }
  process.stderr.write(`  ✓ Domain: ${domain}\n\n`);

  // ── Step 6 — Debounce ────────────────────────────────────────────────────
  process.stderr.write("  Step 6 — Debounce window\n");
  process.stderr.write("  ─────────────────────────\n");
  process.stderr.write("  Obsidian autosaves frequently. Capture only after this many ms of quiet.\n");
  process.stderr.write("  Default 1500ms is a good balance between latency and event volume.\n\n");
  const defaultDebounce = existing.debounce_ms ?? 1500;
  let debounce_ms = defaultDebounce;
  while (true) {
    const raw = await readPlainLine(`  Debounce ms (Enter for ${defaultDebounce}):\n  > `);
    const trimmed = raw.trim();
    if (!trimmed) break;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 100 || n > 60000) {
      process.stderr.write("  Provide a number between 100 and 60000.\n");
      continue;
    }
    debounce_ms = n;
    break;
  }
  process.stderr.write(`  ✓ Debounce: ${debounce_ms}ms\n\n`);

  // ── Save ─────────────────────────────────────────────────────────────────
  const cfg: ObsidianConfig = {
    vault_path,
    domain,
    debounce_ms,
    ...(allowed_subdirs ? { allowed_subdirs } : {}),
    ...(excluded_subdirs ? { excluded_subdirs } : {}),
    ...(allowed_tags ? { allowed_tags } : {}),
    ...(excluded_tags ? { excluded_tags } : {}),
  };
  writeObsidianConfig(cfg);

  process.stderr.write(`  ✓ Obsidian adapter configured. Saved to ${getConfigPath()} (mode 0600)\n\n`);
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-obsidian\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-obsidian\n\n");

  return cfg;
}
