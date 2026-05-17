/**
 * Shared localhost OAuth flow for Google adapters.
 *
 * Replaces the painful "go to oauthplayground.developers.google.com,
 * paste your client id/secret there, sign in, copy the refresh token
 * back" walk-through with an in-terminal flow:
 *
 *   1. Pick a free localhost port and spin up a tiny HTTP listener.
 *   2. Ask the adapter for the authorize URL with our localhost
 *      redirect. The adapter builds it via its own google-auth-library
 *      OAuth2Client (kept out of usrcp-local so we don't have to pull
 *      Google deps here).
 *   3. Print the URL for the user to open. Wait on the localhost
 *      listener for Google's redirect with ?code=<code>.
 *   4. Send a "you can close this tab" HTML page back to the browser.
 *   5. Hand the code to the adapter's exchangeCode() to mint the
 *      refresh_token + access_token via google-auth-library.
 *
 * Generic over the OAuth provider in the sense that the helper does
 * no Google-specific work; the adapter caller plugs in
 * `buildAuthUrl` and `exchangeCode`. Today only google-calendar +
 * gmail use this; if a future non-Google adapter adopts the same
 * localhost-redirect pattern it can reuse the helper unchanged.
 */

import { AddressInfo, createServer, Server } from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";

export interface OAuthFlowOpts {
  /**
   * Build the authorize URL given the localhost redirect URI and the
   * random `state` token the helper has chosen for this flow. The
   * adapter must include `state` in the URL so Google echoes it on
   * the redirect; the helper rejects any redirect whose state does
   * not match.
   */
  buildAuthUrl: (redirectUri: string, state: string) => string | Promise<string>;
  /**
   * Exchange the authorization code for tokens. The adapter receives
   * the same redirect_uri it built the URL with - Google requires the
   * exchange call to use the identical redirect_uri.
   */
  exchangeCode: (
    code: string,
    redirectUri: string
  ) => Promise<{ refresh_token: string; access_token?: string }>;
  /** Timeout for the localhost listener (ms). Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Where to write user-facing prompts. Tests can stub. */
  log?: (msg: string) => void;
}

export interface OAuthFlowResult {
  refresh_token: string;
  access_token?: string;
  /** The exact redirect_uri used; useful for diagnostics. */
  redirect_uri: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const REDIRECT_PATH = "/oauth2callback";

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>USRCP OAuth</title>
<style>body{font-family:system-ui;max-width:32em;margin:6em auto;padding:0 1em;text-align:center}h1{color:#10b981}p{color:#444}</style>
</head><body><h1>Success</h1><p>USRCP captured the authorization. You can close this tab and return to the terminal.</p></body></html>`;

const ERROR_PAGE = (msg: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>USRCP OAuth</title>
<style>body{font-family:system-ui;max-width:32em;margin:6em auto;padding:0 1em;text-align:center}h1{color:#dc2626}pre{background:#f3f4f6;padding:1em;text-align:left;overflow:auto}</style>
</head><body><h1>Authorization failed</h1><pre>${msg.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre></body></html>`;

/**
 * Pick a free localhost port via the OS by binding to port 0 and
 * reading the assigned port. Closes the temporary socket before
 * returning so the real listener can bind to the same number.
 */
/** Constant-time hex comparison; tolerates strings of different lengths. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv: Server = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = (addr as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Parse the redirect path's query string into { code, error, state }.
 * Returns null on a request whose path doesn't match REDIRECT_PATH OR
 * on a malformed URL (an attacker on the same machine can craft
 * invalid absolute-form request targets that would otherwise throw
 * out of `new URL`; treating those as "not our redirect" keeps the
 * listener waiting for the real one).
 */
export function parseRedirect(
  url: string | undefined
): { code?: string; error?: string; state?: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  if (u.pathname !== REDIRECT_PATH) return null;
  const code = u.searchParams.get("code") ?? undefined;
  const error = u.searchParams.get("error") ?? undefined;
  const state = u.searchParams.get("state") ?? undefined;
  return { code, error, state };
}

export async function runLocalhostOauthFlow(opts: OAuthFlowOpts): Promise<OAuthFlowResult> {
  const log = opts.log ?? ((msg) => process.stderr.write(msg));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const port = await pickFreePort();
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;
  // 128-bit random state token. Google echoes this on the redirect;
  // we reject any redirect whose state does not match. Without this,
  // any local process that can target the listener port could race
  // the real redirect and trick us into exchanging a code they
  // chose.
  const state = crypto.randomBytes(16).toString("hex");

  // Build the authorize URL BEFORE starting the listener; if the
  // adapter's buildAuthUrl throws (e.g. malformed client_id), we
  // surface that error without leaving a listener dangling.
  const authUrl = await opts.buildAuthUrl(redirectUri, state);

  // The listener resolves once we see the redirect. The OAuth flow
  // exchanges the code into tokens AFTER we've sent the success page,
  // so the browser tab closes quickly even if the token exchange is
  // slow / fails.
  const capture = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      const server = http.createServer((req, res) => {
        const parsed = parseRedirect(req.url);
        if (!parsed) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // CSRF guard runs FIRST, before the error/code branches.
        // Google echoes `state` on every redirect including error
        // redirects, so a missing-or-wrong state means this request
        // is NOT from Google. Treating it as a 400 + keep waiting
        // stops a local attacker from killing the flow by firing a
        // forged ?error=access_denied at the listener, which would
        // otherwise hit the reject() branch and abort the wizard.
        if (!parsed.state || !timingSafeEqualHex(parsed.state, state)) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.statusCode = 400;
          res.end(ERROR_PAGE("state mismatch"));
          // Don't reject - keep waiting for the legitimate redirect.
          // A real attacker can keep firing forged redirects, but the
          // 5-min timeout bounds the window.
          return;
        }
        if (parsed.error) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.statusCode = 400;
          res.end(ERROR_PAGE(parsed.error));
          cleanup();
          reject(new Error(`Google authorization returned error: ${parsed.error}`));
          return;
        }
        if (!parsed.code) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.statusCode = 400;
          res.end(ERROR_PAGE("missing code"));
          cleanup();
          reject(new Error(`Google authorization redirect missing 'code' parameter`));
          return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(SUCCESS_PAGE);
        cleanup();
        resolve({ code: parsed.code, redirectUri });
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s. Re-run the wizard to try again.`));
      }, timeoutMs);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        server.close();
      };

      server.on("error", (err) => {
        cleanup();
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        log(`  USRCP is listening on ${redirectUri}\n`);
        log(`  Open this URL in your browser, complete the Google\n`);
        log(`  sign-in, and the wizard will continue automatically:\n\n`);
        log(`    ${authUrl}\n\n`);
        log(`  (Waiting up to ${Math.round(timeoutMs / 1000)}s for the redirect...)\n`);
      });
    }
  );

  const tokens = await opts.exchangeCode(capture.code, capture.redirectUri);
  if (!tokens.refresh_token) {
    throw new Error(
      `Google returned no refresh_token. This usually means the consent screen has already granted this client offline access; revoke it under ` +
      `https://myaccount.google.com/permissions and rerun the wizard.`
    );
  }
  return {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    redirect_uri: capture.redirectUri,
  };
}
