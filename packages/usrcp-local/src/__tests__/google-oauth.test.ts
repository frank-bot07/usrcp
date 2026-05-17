import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { parseRedirect, runLocalhostOauthFlow } from "../adapters/google-oauth/index.js";

/**
 * Drive the localhost OAuth flow end-to-end without involving Google.
 * The adapter's `buildAuthUrl` returns a URL string we don't open;
 * we extract the host+port from the redirect_uri and POST/GET to
 * the callback ourselves to simulate Google's redirect.
 */
async function driveRedirect(
  redirectUri: string,
  query: Record<string, string>
): Promise<{ status: number; body: string }> {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseRedirect", () => {
  it("extracts ?code= and ?state= from the callback path", () => {
    expect(parseRedirect("/oauth2callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      error: undefined,
      state: "xyz",
    });
  });

  it("extracts ?error= from the callback path", () => {
    expect(parseRedirect("/oauth2callback?error=access_denied")).toEqual({
      code: undefined,
      error: "access_denied",
      state: undefined,
    });
  });

  it("returns null for unrelated paths", () => {
    expect(parseRedirect("/anything-else?code=abc")).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseRedirect(undefined)).toBeNull();
  });

  it("returns null for malformed URLs without throwing", () => {
    // Some local clients (or attackers) can send absolute-form
    // request targets that `new URL()` would reject. The helper must
    // treat those as "not our redirect" rather than crash.
    expect(parseRedirect("http://[::malformed")).toBeNull();
    expect(parseRedirect("not a url at all")).toBeNull();
  });
});

/**
 * Build a `log` callback + `ready` promise pair. The helper calls
 * `log("USRCP is listening on ...")` after `server.listen()` resolves;
 * the test uses that as the trigger to drive its fake redirect, so we
 * never race the server's bind.
 */
function readySignal(): { log: (msg: string) => void; ready: Promise<void> } {
  let resolve: () => void;
  const ready = new Promise<void>((r) => { resolve = r; });
  const log = (msg: string): void => {
    if (msg.includes("listening on")) resolve();
  };
  return { log, ready };
}

describe("runLocalhostOauthFlow", () => {
  it("captures the authorization code, sends a success page, and returns the tokens", async () => {
    const exchangeCode = vi.fn(async (code: string, _redirectUri: string) => {
      expect(code).toBe("mock-auth-code");
      return { refresh_token: "1//refresh", access_token: "ya29.access" };
    });

    let observedAuthUrl: string | undefined;
    const { log, ready } = readySignal();
    const buildAuthUrl = (redirectUri: string, state: string): string => {
      const u = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      observedAuthUrl = u;
      void ready.then(async () => {
        const res = await driveRedirect(redirectUri, { code: "mock-auth-code", state });
        expect(res.status).toBe(200);
        expect(res.body).toContain("Success");
      });
      return u;
    };

    const result = await runLocalhostOauthFlow({
      buildAuthUrl,
      exchangeCode,
      timeoutMs: 5000,
      log,
    });

    expect(result.refresh_token).toBe("1//refresh");
    expect(result.access_token).toBe("ya29.access");
    expect(result.redirect_uri.startsWith("http://127.0.0.1:")).toBe(true);
    expect(observedAuthUrl).toBeDefined();
    expect(exchangeCode).toHaveBeenCalledOnce();
  });

  it("rejects when the redirect carries ?error= and serves an error page", async () => {
    const exchangeCode = vi.fn(async () => ({ refresh_token: "should-not-mint" }));
    const { log, ready } = readySignal();
    const buildAuthUrl = (redirectUri: string, _state: string): string => {
      // The error path doesn't need to carry a valid state - errors
      // are surfaced regardless. (Google's real redirect would still
      // include state on errors; we just don't validate it then.)
      void ready.then(() => driveRedirect(redirectUri, { error: "access_denied" }).catch(() => { /* */ }));
      return "https://accounts.google.com/o/oauth2/v2/auth";
    };

    await expect(
      runLocalhostOauthFlow({ buildAuthUrl, exchangeCode, timeoutMs: 5000, log })
    ).rejects.toThrow(/access_denied/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects when the redirect is missing both code and error", async () => {
    const exchangeCode = vi.fn(async () => ({ refresh_token: "stub" }));
    const { log, ready } = readySignal();
    const buildAuthUrl = (redirectUri: string, state: string): string => {
      // Pass state so the state check passes; then the missing-code
      // path fires.
      void ready.then(() => driveRedirect(redirectUri, { state }).catch(() => { /* */ }));
      return "https://accounts.google.com/o/oauth2/v2/auth";
    };
    await expect(
      runLocalhostOauthFlow({ buildAuthUrl, exchangeCode, timeoutMs: 5000, log })
    ).rejects.toThrow(/missing 'code'/);
  });

  it("returns a clear error when Google withheld refresh_token", async () => {
    const exchangeCode = vi.fn(async () => ({ access_token: "ya29.x", refresh_token: "" }));
    const { log, ready } = readySignal();
    const buildAuthUrl = (redirectUri: string, state: string): string => {
      void ready.then(() =>
        driveRedirect(redirectUri, { code: "mock-auth-code", state }).catch(() => { /* */ })
      );
      return "https://accounts.google.com/o/oauth2/v2/auth";
    };
    await expect(
      runLocalhostOauthFlow({ buildAuthUrl, exchangeCode, timeoutMs: 5000, log })
    ).rejects.toThrow(/no refresh_token/i);
  });

  it("rejects redirects whose state does not match (CSRF guard)", async () => {
    // An attacker on the same machine crafts a redirect with a forged
    // code but no/wrong state. The helper must NOT exchange that code
    // and must keep waiting for the legitimate redirect (which never
    // arrives in this test, so we hit the timeout).
    const exchangeCode = vi.fn(async () => ({ refresh_token: "stolen" }));
    const { log, ready } = readySignal();
    const buildAuthUrl = (redirectUri: string, _state: string): string => {
      void ready.then(async () => {
        // First: forged redirect with no state. Helper should reject
        // with a 400 page and keep listening.
        const a = await driveRedirect(redirectUri, { code: "attacker-code" });
        expect(a.status).toBe(400);
        expect(a.body).toContain("state mismatch");
        // Second: forged redirect with a wrong state.
        const b = await driveRedirect(redirectUri, { code: "attacker-code", state: "ff".repeat(16) });
        expect(b.status).toBe(400);
        expect(b.body).toContain("state mismatch");
      });
      return "https://accounts.google.com/o/oauth2/v2/auth";
    };
    await expect(
      runLocalhostOauthFlow({ buildAuthUrl, exchangeCode, timeoutMs: 200, log })
    ).rejects.toThrow(/timed out/i);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("times out when the user never opens the URL", async () => {
    const exchangeCode = vi.fn();
    const buildAuthUrl = (): string => "https://accounts.google.com/o/oauth2/v2/auth";
    await expect(
      runLocalhostOauthFlow({
        buildAuthUrl,
        exchangeCode,
        timeoutMs: 50, // tight for the test
        log: () => { /* */ },
      })
    ).rejects.toThrow(/timed out/i);
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});
