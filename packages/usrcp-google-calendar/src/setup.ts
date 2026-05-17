/**
 * Interactive setup wizard for the Google Calendar adapter.
 *
 * Google requires a real OAuth client and a refresh token; there is no
 * "personal API key" shortcut for user data. The wizard takes the
 * three secrets the user obtained out-of-band (Google Cloud Console
 * for the client_id/secret + Google OAuth Playground for a refresh
 * token scoped to https://www.googleapis.com/auth/calendar.readonly)
 * and validates them by fetching the primary calendar's metadata
 * before persisting.
 *
 * Detailed setup instructions live in the package README.
 */

import { OAuth2Client } from "google-auth-library";
import { runLocalhostOauthFlow } from "usrcp-local/dist/adapters/google-oauth/index.js";
import {
  getConfigPath,
  writeGoogleCalendarConfig,
  readPartialConfig,
  type GoogleCalendarConfig,
} from "./config.js";
import { validateCredentials } from "./reader.js";

const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

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
  // Same posture as the Linear / Slack wizards: terminal echoes during
  // entry, masked only on echo-back. The shell history is the bigger
  // exposure surface than echo here.
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

export async function runGoogleCalendarSetup(): Promise<GoogleCalendarConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-google-calendar setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  const existing = readPartialConfig();

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Google Calendar adapter setup ────────────────────────────┐\n");
  process.stderr.write("  │ Polls your primary Google Calendar for past events you      │\n");
  process.stderr.write("  │ attended and appends them to your USRCP ledger.             │\n");
  process.stderr.write("  │ v0: capture-only, primary calendar only, no stream sync.    │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/google-calendar-config.json (0600) │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  process.stderr.write("  Before running this wizard you need three OAuth secrets.\n");
  process.stderr.write("  See packages/usrcp-google-calendar/README.md for the exact\n");
  process.stderr.write("  Google Cloud Console + OAuth Playground steps. Briefly:\n");
  process.stderr.write("    1. Create a 'Desktop app' OAuth client in console.cloud.google.com\n");
  process.stderr.write("       -> APIs & Services -> Credentials. Note the client_id + secret.\n");
  process.stderr.write("    2. Enable the Calendar API on that project.\n");
  process.stderr.write("    3. Visit developers.google.com/oauthplayground, click the gear\n");
  process.stderr.write("       icon, tick 'Use your own OAuth credentials', paste the\n");
  process.stderr.write("       client_id + secret. Then authorise the scope\n");
  process.stderr.write("       https://www.googleapis.com/auth/calendar.readonly and exchange\n");
  process.stderr.write("       the auth code for tokens. Copy the refresh_token.\n\n");

  // ── Step 1 - OAuth client_id ─────────────────────────────────────────────
  process.stderr.write("  Step 1 - OAuth client_id\n");
  process.stderr.write("  ─────────────────────────\n");
  let oauth_client_id = "";
  while (true) {
    const promptSuffix = existing.oauth_client_id
      ? ` (Enter to keep ${maskSecret(existing.oauth_client_id)})`
      : "";
    const raw = await readPlainLine(`  client_id${promptSuffix}:\n  > `);
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
    const promptSuffix = existing.oauth_client_secret
      ? ` (Enter to keep ${maskSecret(existing.oauth_client_secret)})`
      : "";
    const raw = await readSecret(`  client_secret${promptSuffix}:\n  > `);
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

  // The localhost browser flow is the default; offer the manual
  // OAuth-Playground path as a fallback for users who can't open a
  // browser from the same machine (remote shell, CI, etc.).
  const useBrowserFlow = await readYN(
    "  Authorise via browser on this machine? (recommended)",
    true
  );

  let refresh_token = "";
  let userEmail = "";
  let calendarSummary = "";

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
              scope: [CALENDAR_READONLY_SCOPE],
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
    process.stderr.write("  Validating against Google Calendar API...\n");
    const result = await validateCredentials({ oauth_client_id, oauth_client_secret, refresh_token });
    if (!result.ok) {
      process.stderr.write(`  ✗ Validation failed: ${result.error}\n`);
      process.exit(1);
    }
    userEmail = result.email;
    calendarSummary = result.calendar_summary;
    process.stderr.write(`  ✓ Authenticated as ${userEmail} (calendar: ${calendarSummary})\n\n`);
  } else while (true) {
    // Manual fallback: user pastes a refresh_token they obtained via
    // Google's OAuth Playground or a separate flow.
    const promptSuffix = existing.refresh_token
      ? ` (Enter to keep ${maskSecret(existing.refresh_token)})`
      : "";
    const raw = await readSecret(`  refresh_token${promptSuffix}:\n  > `);
    const trimmed = raw.trim();
    const candidate = !trimmed && existing.refresh_token ? existing.refresh_token : trimmed;
    if (!candidate) {
      process.stderr.write("  refresh_token cannot be empty.\n");
      continue;
    }
    process.stderr.write("  Validating against Google Calendar API...\n");
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
    calendarSummary = result.calendar_summary;
    process.stderr.write(`  ✓ Authenticated as ${userEmail} (calendar: ${calendarSummary})\n\n`);
    break;
  }

  // ── Step 4 - Polling interval ────────────────────────────────────────────
  process.stderr.write("  Step 4 - Polling interval\n");
  process.stderr.write("  ──────────────────────────\n");
  process.stderr.write("  How often (seconds) to query Calendar for newly-ended events.\n");
  process.stderr.write("  Google's Calendar API budget is generous; 300s (5 min) is typical.\n\n");
  const defaultInterval = existing.poll_interval_s ?? 300;
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
  process.stderr.write("  Use 'calendar' as a default, or 'work' to merge with other surfaces.\n\n");
  const defaultDomain = existing.domain ?? "calendar";
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
  const cfg: GoogleCalendarConfig = {
    oauth_client_id,
    oauth_client_secret,
    refresh_token,
    poll_interval_s,
    domain,
    // last_synced_at deliberately not carried over; reusing a stale
    // cursor on a fresh setup could silently miss recent events.
  };
  writeGoogleCalendarConfig(cfg);

  process.stderr.write(`  ✓ Google Calendar adapter configured. Saved to ${getConfigPath()} (mode 0600)\n\n`);
  process.stderr.write("  What's next:\n");
  process.stderr.write("    usrcp-google-calendar\n");
  process.stderr.write("    # or: USRCP_PASSPHRASE=<pp> usrcp-google-calendar\n\n");

  return cfg;
}
