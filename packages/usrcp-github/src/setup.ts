/**
 * Interactive setup wizard. Validates the PAT by issuing a /user
 * lookup before persisting, so a typo fails at the wizard, not at
 * first poll.
 */

import { Octokit } from "@octokit/rest";
import {
  getConfigPath,
  writeGitHubConfig,
  readPartialDecryptedConfig,
  type GitHubConfig,
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

interface OrgSummary {
  login: string;
  name: string | null;
}

async function fetchOrgs(octokit: Octokit): Promise<OrgSummary[]> {
  // Public orgs the token has access to. Fine-grained PATs may scope this
  // tighter than classic PATs - we just list whatever the token sees.
  const orgs = await octokit.paginate(octokit.orgs.listForAuthenticatedUser, {
    per_page: 100,
  });
  return orgs.map((o) => ({ login: o.login, name: o.description ?? null }));
}

interface TokenValidation {
  ok: true;
  login: string;
  name: string | null;
  orgs: OrgSummary[];
}

interface TokenValidationError {
  ok: false;
  error: string;
}

async function validateToken(token: string): Promise<TokenValidation | TokenValidationError> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data: user } = await octokit.users.getAuthenticated();
    const orgs = await fetchOrgs(octokit);
    return {
      ok: true,
      login: user.login,
      name: user.name ?? null,
      orgs,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

export async function runGithubSetup(
  opts: { masterKey?: Buffer } = {},
): Promise<GitHubConfig> {
  if (!opts.masterKey) {
    console.error(
      "usrcp-github setup: master key missing. Run via `usrcp setup --adapter=github` so the wizard can encrypt your PAT at rest.",
    );
    process.exit(1);
  }
  const masterKey = opts.masterKey;
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-github setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`,
    );
    process.exit(1);
  }

  const existing = readPartialDecryptedConfig(masterKey);

  process.stderr.write("\n");
  process.stderr.write("  ┌─ GitHub adapter setup ──────────────────────────────────────┐\n");
  process.stderr.write("  │ Polls GitHub's REST API for pull requests YOU author and    │\n");
  process.stderr.write("  │ appends them to your USRCP ledger.                          │\n");
  process.stderr.write("  │ v1: capture pr_opened events only (state changes come later).│\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/github-config.json (mode 0600)     │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // Step 1 - Personal access token
  process.stderr.write("  Step 1 - GitHub personal access token\n");
  process.stderr.write("  ──────────────────────────────────────\n");
  process.stderr.write("  Open https://github.com/settings/tokens in a browser.\n");
  process.stderr.write("  Either token type works:\n");
  process.stderr.write("    - Classic PAT (ghp_*): needs `repo` and `read:org` scopes.\n");
  process.stderr.write("    - Fine-grained (github_pat_*): grant Pull requests: read on each repo.\n\n");

  let github_token = "";
  let github_login = "";
  let displayName: string | null = null;
  let orgs: OrgSummary[] = [];
  while (true) {
    const promptSuffix = existing.github_token
      ? ` (Enter to keep ${maskKey(existing.github_token)})`
      : "";
    const raw = await readPlainLine(`  Paste your PAT${promptSuffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.github_token ? existing.github_token : trimmed;
    if (!candidate) {
      process.stderr.write("  Token cannot be empty.\n");
      continue;
    }
    process.stderr.write("  Validating against api.github.com...\n");
    const result = await validateToken(candidate);
    if (!result.ok) {
      process.stderr.write(`  ✗ Validation failed: ${result.error}\n`);
      const retry = await readYN("  Try again?", true);
      if (!retry) process.exit(1);
      continue;
    }
    github_token = candidate;
    github_login = result.login;
    displayName = result.name;
    orgs = result.orgs;
    break;
  }
  process.stderr.write(
    `  ✓ Authenticated as ${github_login}${displayName ? ` (${displayName})` : ""}\n\n`,
  );

  // Step 2 - Optional org allowlist
  process.stderr.write("  Step 2 - Orgs to capture from\n");
  process.stderr.write("  ──────────────────────────────\n");

  let allowlisted_orgs: string[] = [];
  if (orgs.length === 0) {
    process.stderr.write("  No orgs visible to this token. Will capture across all repos\n");
    process.stderr.write("  the token can see (user-owned + public-collaborator).\n\n");
  } else {
    process.stderr.write(`  Found ${orgs.length} org${orgs.length === 1 ? "" : "s"}:\n`);
    orgs.forEach((o, i) => {
      const tag = o.name ? `  (${o.name})` : "";
      process.stderr.write(`    [${i + 1}] ${o.login}${tag}\n`);
    });
    process.stderr.write("\n");
    process.stderr.write("  Empty = no allowlist (capture from every repo the token can see,\n");
    process.stderr.write("  including user-owned repos and public-collab repos outside any org).\n\n");

    while (true) {
      const defaultHint = existing.allowlisted_orgs?.length
        ? ` (Enter for existing ${existing.allowlisted_orgs.length})`
        : " (or 'all', or Enter for no allowlist)";
      const raw = await readPlainLine(
        `  Numbers to allowlist, comma-separated${defaultHint}:\n  > `,
      );
      const trimmed = raw.trim();
      if (!trimmed) {
        if (existing.allowlisted_orgs?.length) {
          // Reuse existing, dropping any org the token can no longer see.
          const live = new Set(orgs.map((o) => o.login));
          allowlisted_orgs = existing.allowlisted_orgs.filter((o) => live.has(o));
        } else {
          allowlisted_orgs = [];
        }
        break;
      }
      const indices = parseIndices(trimmed, orgs.length);
      if (indices.length === 0) {
        process.stderr.write(`  Pick orgs 1..${orgs.length}, 'all', or just Enter.\n`);
        continue;
      }
      allowlisted_orgs = indices.map((i) => orgs[i].login);
      break;
    }
    if (allowlisted_orgs.length === 0) {
      process.stderr.write("  ✓ No allowlist - all visible repos in scope.\n\n");
    } else {
      process.stderr.write(`  ✓ Orgs: ${allowlisted_orgs.join(", ")}\n\n`);
    }
  }

  // Step 3 - Polling interval
  process.stderr.write("  Step 3 - Polling interval\n");
  process.stderr.write("  ──────────────────────────\n");
  process.stderr.write("  How often (seconds) to query GitHub for new PRs.\n");
  process.stderr.write("  GitHub's Search API is rate-limited to 30 requests/minute for\n");
  process.stderr.write("  authenticated users; 600s (10 min) is conservative.\n\n");
  const defaultInterval = existing.poll_interval_s ?? 600;
  let poll_interval_s = defaultInterval;
  while (true) {
    const raw = await readPlainLine(`  Interval seconds (Enter for ${defaultInterval}):\n  > `);
    const trimmed = raw.trim();
    if (!trimmed) break;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 60 || n > 3600) {
      process.stderr.write("  Provide a number between 60 and 3600.\n");
      continue;
    }
    poll_interval_s = n;
    break;
  }
  process.stderr.write(`  ✓ Interval: ${poll_interval_s}s\n\n`);

  // Step 4 - Domain
  process.stderr.write("  Step 4 - USRCP domain name\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Events from this adapter are written under this domain.\n");
  process.stderr.write("  Use 'github' as a default, or 'coding'/'work' to merge with other surfaces.\n\n");
  const defaultDomain = existing.domain ?? "github";
  let domain = "";
  while (true) {
    const raw = await readPlainLine(`  Domain (Enter for "${defaultDomain}"):\n  > `);
    const trimmed = raw.trim();
    if (!trimmed) {
      domain = defaultDomain;
      break;
    }
    if (!/^[a-z0-9_-]{1,40}$/.test(trimmed)) {
      process.stderr.write("  Use 1-40 chars, lowercase letters/digits/underscore/dash only.\n");
      continue;
    }
    domain = trimmed;
    break;
  }
  process.stderr.write(`  ✓ Domain: ${domain}\n\n`);

  const cfg: GitHubConfig = {
    github_token,
    github_login,
    allowlisted_orgs,
    poll_interval_s,
    domain,
  };
  writeGitHubConfig(cfg, masterKey);

  process.stderr.write(`  ✓ GitHub adapter configured. Saved to ${getConfigPath()} (mode 0600)\n\n`);
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-github\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-github\n\n");

  return cfg;
}
