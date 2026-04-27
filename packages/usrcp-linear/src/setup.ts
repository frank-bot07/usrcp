/**
 * Interactive setup wizard. Validates the API key by issuing a viewer query
 * before persisting, so a typo fails at the wizard, not at first poll.
 */

import { LinearClient } from "@linear/sdk";
import {
  getConfigPath,
  writeLinearConfig,
  readPartialConfig,
  type LinearConfig,
} from "./config.js";

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

function readSecret(prompt: string): Promise<string> {
  // Terminal echoes during input; we mask only when displaying back. Matches
  // the imessage/obsidian wizards.
  return readPlainLine(prompt);
}

function readYN(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return readPlainLine(`${prompt} ${hint} `).then((ans) => {
    const a = ans.trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  });
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "…" + key.slice(-4);
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

interface TeamSummary {
  id: string;
  name: string;
  key: string;
}

async function fetchTeams(client: LinearClient): Promise<TeamSummary[]> {
  const conn = await client.teams();
  return conn.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
}

async function validateApiKey(apiKey: string): Promise<{ ok: true; viewer: { name: string; email?: string }; teams: TeamSummary[] } | { ok: false; error: string }> {
  try {
    const client = new LinearClient({ apiKey });
    const viewer = await client.viewer;
    const teams = await fetchTeams(client);
    return {
      ok: true,
      viewer: { name: viewer.name, email: viewer.email ?? undefined },
      teams,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runLinearSetup(): Promise<LinearConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-linear setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  const existing = readPartialConfig();

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Linear adapter setup ─────────────────────────────────────┐\n");
  process.stderr.write("  │ Polls Linear's GraphQL API for issues and comments YOU      │\n");
  process.stderr.write("  │ author and appends them to your USRCP ledger.               │\n");
  process.stderr.write("  │ v0: capture-only (no @usrcp replies).                       │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/linear-config.json (mode 0600)     │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Step 1 — API key ─────────────────────────────────────────────────────
  process.stderr.write("  Step 1 — Linear personal API key\n");
  process.stderr.write("  ─────────────────────────────────\n");
  process.stderr.write("  Open https://linear.app/settings/api in a browser.\n");
  process.stderr.write("  Click 'Personal API keys → Create key'. Copy the value.\n\n");

  let linear_api_key = "";
  let viewer: { name: string; email?: string } | undefined;
  let teams: TeamSummary[] = [];
  while (true) {
    const promptSuffix = existing.linear_api_key
      ? ` (Enter to keep ${maskKey(existing.linear_api_key)})`
      : "";
    const raw = await readSecret(`  API key${promptSuffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.linear_api_key ? existing.linear_api_key : trimmed;
    if (!candidate) {
      process.stderr.write("  Key cannot be empty.\n");
      continue;
    }
    process.stderr.write("  Validating...\n");
    const result = await validateApiKey(candidate);
    if (!result.ok) {
      process.stderr.write(`  ✗ Validation failed: ${result.error}\n`);
      const retry = await readYN("  Try again?", true);
      if (!retry) process.exit(1);
      continue;
    }
    linear_api_key = candidate;
    viewer = result.viewer;
    teams = result.teams;
    break;
  }
  process.stderr.write(`  ✓ Authenticated as ${viewer!.name}${viewer!.email ? ` <${viewer!.email}>` : ""}\n\n`);

  // ── Step 2 — Team allowlist ──────────────────────────────────────────────
  process.stderr.write("  Step 2 — Teams to capture from\n");
  process.stderr.write("  ───────────────────────────────\n");

  if (teams.length === 0) {
    process.stderr.write("  ✗ No teams found in this workspace. Cannot proceed.\n");
    process.exit(1);
  }

  process.stderr.write(`  Found ${teams.length} team${teams.length === 1 ? "" : "s"}:\n`);
  teams.forEach((t, i) => process.stderr.write(`    [${i + 1}] ${t.key}  ${t.name}\n`));
  process.stderr.write("\n");

  let allowlisted_team_ids: string[] = [];
  while (true) {
    const defaultHint = existing.allowlisted_team_ids?.length
      ? ` (Enter for existing ${existing.allowlisted_team_ids.length})`
      : " (or 'all')";
    const raw = await readPlainLine(`  Numbers to allowlist, comma-separated${defaultHint}:\n  > `);
    if (!raw.trim() && existing.allowlisted_team_ids?.length) {
      // Filter the existing list against the live teams — drop IDs the user
      // no longer has access to, otherwise the daemon would silently skip
      // them with team_not_allowlisted forever.
      const liveIds = new Set(teams.map((t) => t.id));
      allowlisted_team_ids = existing.allowlisted_team_ids.filter((id) => liveIds.has(id));
      if (allowlisted_team_ids.length === 0) {
        process.stderr.write("  Existing IDs no longer match any team. Pick again.\n");
        continue;
      }
      break;
    }
    const indices = parseIndices(raw, teams.length);
    if (indices.length === 0) {
      process.stderr.write(`  Pick at least one team (1..${teams.length}) or 'all'.\n`);
      continue;
    }
    allowlisted_team_ids = indices.map((i) => teams[i].id);
    break;
  }
  const pickedKeys = allowlisted_team_ids
    .map((id) => teams.find((t) => t.id === id)?.key ?? id)
    .join(", ");
  process.stderr.write(`  ✓ Teams: ${pickedKeys}\n\n`);

  // ── Step 3 — Polling interval ────────────────────────────────────────────
  process.stderr.write("  Step 3 — Polling interval\n");
  process.stderr.write("  ──────────────────────────\n");
  process.stderr.write("  How often (seconds) to query Linear for new activity.\n");
  process.stderr.write("  Lower = fresher, more API calls. Linear's limit is 1500/hr.\n\n");
  const defaultInterval = existing.poll_interval_s ?? 60;
  let poll_interval_s = defaultInterval;
  while (true) {
    const raw = await readPlainLine(`  Interval seconds (Enter for ${defaultInterval}):\n  > `);
    const trimmed = raw.trim();
    if (!trimmed) break;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 15 || n > 3600) {
      process.stderr.write("  Provide a number between 15 and 3600.\n");
      continue;
    }
    poll_interval_s = n;
    break;
  }
  process.stderr.write(`  ✓ Interval: ${poll_interval_s}s\n\n`);

  // ── Step 4 — Domain ──────────────────────────────────────────────────────
  process.stderr.write("  Step 4 — USRCP domain name\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Events from this adapter are written under this domain.\n");
  process.stderr.write("  Use 'linear' as a default, or 'work' to merge with other surfaces.\n\n");
  const defaultDomain = existing.domain ?? "linear";
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

  // ── Save ─────────────────────────────────────────────────────────────────
  const cfg: LinearConfig = {
    linear_api_key,
    allowlisted_team_ids,
    poll_interval_s,
    domain,
    // last_synced_at is intentionally NOT carried over; reusing an old
    // cursor on a fresh setup would silently miss recent activity if the
    // user had deleted and recreated config.
  };
  writeLinearConfig(cfg);

  process.stderr.write(`  ✓ Linear adapter configured. Saved to ${getConfigPath()} (mode 0600)\n\n`);
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-linear\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-linear\n\n");

  return cfg;
}
