/**
 * Interactive setup wizard for the Gmail adapter. Same OAuth posture
 * as the Google Calendar adapter (#51): the user supplies an OAuth
 * client_id + secret from Google Cloud Console plus a refresh_token
 * minted via Google's OAuth Playground; the wizard validates by
 * calling users.getProfile before persisting.
 *
 * Detailed setup instructions live in the package README. The only
 * difference from the Calendar adapter's wizard is the requested
 * OAuth scope:
 *   https://www.googleapis.com/auth/gmail.readonly
 */

import { OAuth2Client } from "google-auth-library";
import { runLocalhostOauthFlow } from "usrcp-local/dist/adapters/google-oauth/index.js";
import {
  getConfigPath,
  writeGmailConfig,
  readPartialConfig,
  type GmailConfig,
} from "./config.js";
import { validateCredentials } from "./reader.js";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "…" + secret.slice(-4);
}

export async function runGmailSetup(): Promise<GmailConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-gmail setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  const existing = readPartialConfig();

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Gmail adapter setup ──────────────────────────────────────┐\n");
  process.stderr.write("  │ Polls your Gmail for messages YOU sent and appends them     │\n");
  process.stderr.write("  │ to your USRCP ledger as event_sent entries.                 │\n");
  process.stderr.write("  │ v0: SENT messages only, no replies, no stream sync.         │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/gmail-config.json (mode 0600)      │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  process.stderr.write("  Before running this wizard you need three OAuth secrets.\n");
  process.stderr.write("  See packages/usrcp-gmail/README.md for the exact Google Cloud\n");
  process.stderr.write("  Console + OAuth Playground steps. Briefly:\n");
  process.stderr.write("    1. Create a 'Desktop app' OAuth client in console.cloud.google.com\n");
  process.stderr.write("       -> APIs & Services -> Credentials. Note the client_id + secret.\n");
  process.stderr.write("    2. Enable the Gmail API on that project.\n");
  process.stderr.write("    3. Visit developers.google.com/oauthplayground, click the gear\n");
  process.stderr.write("       icon, tick 'Use your own OAuth credentials', paste the\n");
  process.stderr.write("       client_id + secret. Authorise the scope\n");
  process.stderr.write("       https://www.googleapis.com/auth/gmail.readonly and exchange\n");
  process.stderr.write("       the auth code for tokens. Copy the refresh_token.\n\n");

  // ── Step 1 - OAuth client_id ─────────────────────────────────────────────
  process.stderr.write("  Step 1 - OAuth client_id\n");
  process.stderr.write("  ─────────────────────────\n");
  let oauth_client_id = "";
  while (true) {
    const suffix = existing.oauth_client_id ? ` (Enter to keep ${maskSecret(existing.oauth_client_id)})` : "";
    const raw = await readPlainLine(`  client_id${suffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.oauth_client_id ? existing.oauth_client_id : trimmed;
    if (!candidate) {
      process.stderr.write("  client_id cannot be empty.\n");
      continue;
    }
    oauth_client_id = candidate;
    break;
  }

  // ── Step 2 - OAuth client_secret ─────────────────────────────────────────
  process.stderr.write("\n  Step 2 - OAuth client_secret\n");
  process.stderr.write("  ─────────────────────────────\n");
  let oauth_client_secret = "";
  while (true) {
    const suffix = existing.oauth_client_secret ? ` (Enter to keep ${maskSecret(existing.oauth_client_secret)})` : "";
    const raw = await readSecret(`  client_secret${suffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.oauth_client_secret ? existing.oauth_client_secret : trimmed;
    if (!candidate) {
      process.stderr.write("  client_secret cannot be empty.\n");
      continue;
    }
    oauth_client_secret = candidate;
    break;
  }

  // ── Step 3 - refresh_token ───────────────────────────────────────────────
  process.stderr.write("\n  Step 3 - OAuth refresh_token\n");
  process.stderr.write("  ─────────────────────────────\n");
  // The localhost browser flow is the default; the manual
  // OAuth-Playground path is the fallback for users who can't open a
  // browser from this machine (remote shell, CI, etc.).
  const useBrowserFlow = await readYN(
    "  Authorise via browser on this machine? (recommended)",
    true
  );

  let refresh_token = "";
  let userEmail = "";
  let messageTotal = 0;

  if (useBrowserFlow) {
    while (true) {
      try {
        const flow = await runLocalhostOauthFlow({
          buildAuthUrl: (redirectUri) => {
            const oauth = new OAuth2Client({
              clientId: oauth_client_id,
              clientSecret: oauth_client_secret,
              redirectUri,
            });
            return oauth.generateAuthUrl({
              access_type: "offline",
              prompt: "consent",
              scope: [GMAIL_READONLY_SCOPE],
              redirect_uri: redirectUri,
            });
          },
          exchangeCode: async (code, redirectUri) => {
            const oauth = new OAuth2Client({
              clientId: oauth_client_id,
              clientSecret: oauth_client_secret,
              redirectUri,
            });
            const { tokens } = await oauth.getToken(code);
            return {
              refresh_token: tokens.refresh_token ?? "",
              access_token: tokens.access_token ?? undefined,
            };
          },
        });
        refresh_token = flow.refresh_token;
        break;
      } catch (err) {
        process.stderr.write(`  ✗ Browser flow failed: ${err instanceof Error ? err.message : String(err)}\n`);
        const retry = await readYN("  Try again?", true);
        if (!retry) process.exit(1);
      }
    }
    process.stderr.write("  Validating against Gmail API...\n");
    const result = await validateCredentials({ oauth_client_id, oauth_client_secret, refresh_token });
    if (!result.ok) {
      process.stderr.write(`  ✗ Validation failed: ${result.error}\n`);
      process.exit(1);
    }
    userEmail = result.email;
    messageTotal = result.total_messages;
    process.stderr.write(`  ✓ Authenticated as ${userEmail} (${messageTotal} messages total)\n\n`);
  } else while (true) {
    const suffix = existing.refresh_token ? ` (Enter to keep ${maskSecret(existing.refresh_token)})` : "";
    const raw = await readSecret(`  refresh_token${suffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.refresh_token ? existing.refresh_token : trimmed;
    if (!candidate) {
      process.stderr.write("  refresh_token cannot be empty.\n");
      continue;
    }
    process.stderr.write("  Validating against Gmail API...\n");
    const result = await validateCredentials({
      oauth_client_id,
      oauth_client_secret,
      refresh_token: candidate,
    });
    if (!result.ok) {
      process.stderr.write(`  ✗ Validation failed: ${result.error}\n`);
      const retry = await readYN("  Try again?", true);
      if (!retry) process.exit(1);
      continue;
    }
    refresh_token = candidate;
    userEmail = result.email;
    messageTotal = result.total_messages;
    process.stderr.write(`  ✓ Authenticated as ${userEmail} (${messageTotal} messages total)\n\n`);
    break;
  }

  // ── Step 4 - Polling interval ────────────────────────────────────────────
  process.stderr.write("  Step 4 - Polling interval\n");
  process.stderr.write("  ──────────────────────────\n");
  process.stderr.write("  How often (seconds) to query Gmail for newly-sent mail.\n");
  process.stderr.write("  Gmail's per-user budget is generous; 600s (10 min) is typical.\n\n");
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

  // ── Step 5 - Domain ──────────────────────────────────────────────────────
  process.stderr.write("  Step 5 - USRCP domain name\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Events from this adapter are written under this domain.\n");
  process.stderr.write("  Use 'email' as a default, or 'work' to merge with other surfaces.\n\n");
  const defaultDomain = existing.domain ?? "email";
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

  const cfg: GmailConfig = {
    oauth_client_id,
    oauth_client_secret,
    refresh_token,
    poll_interval_s,
    domain,
  };
  writeGmailConfig(cfg);

  process.stderr.write(`  ✓ Gmail adapter configured. Saved to ${getConfigPath()} (mode 0600)\n\n`);
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-gmail\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-gmail\n\n");

  return cfg;
}
