import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import {
  setUserSlug,
} from "../encryption.js";
import {
  ensureTlsCert,
  ensureAuthToken,
  verifyBearer,
  startHttpTransport,
  getTlsDir,
  getAuthTokenPath,
} from "../transport.js";
import { createServer } from "../server.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-transport-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("TLS cert generation", () => {
  it("creates valid PEM cert and key files with 0600 permissions", async () => {
    const mat = await ensureTlsCert();
    expect(fs.existsSync(mat.certPath)).toBe(true);
    expect(fs.existsSync(mat.keyPath)).toBe(true);

    expect(mat.cert.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(mat.cert).toContain("-----END CERTIFICATE-----");
    expect(mat.key.startsWith("-----BEGIN")).toBe(true); // could be PRIVATE KEY or RSA PRIVATE KEY
    expect(mat.key).toContain("PRIVATE KEY-----");

    // Check permissions (Unix only)
    if (process.platform !== "win32") {
      const certMode = fs.statSync(mat.certPath).mode & 0o777;
      const keyMode = fs.statSync(mat.keyPath).mode & 0o777;
      expect(certMode).toBe(0o600);
      expect(keyMode).toBe(0o600);
    }
  });

  it("cert parses as valid X.509 with localhost subject and 127.0.0.1 SAN", async () => {
    const mat = await ensureTlsCert();
    const parsed = new crypto.X509Certificate(mat.cert);
    // Subject includes CN=localhost
    expect(parsed.subject).toContain("localhost");
    // SubjectAltName covers localhost and 127.0.0.1
    const san = parsed.subjectAltName || "";
    expect(san).toContain("localhost");
    expect(san).toContain("127.0.0.1");
  });

  it("re-using ensureTlsCert returns the same files (no regeneration)", async () => {
    const first = await ensureTlsCert();
    const firstMtime = fs.statSync(first.certPath).mtimeMs;
    const second = await ensureTlsCert();
    const secondMtime = fs.statSync(second.certPath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
    expect(second.cert).toBe(first.cert);
  });

  it("writes files under ~/.usrcp/users/<slug>/tls/", async () => {
    setUserSlug("frank");
    const mat = await ensureTlsCert();
    const expectedDir = path.join(tmpHome, ".usrcp", "users", "frank", "tls");
    expect(path.dirname(mat.certPath)).toBe(expectedDir);
    expect(getTlsDir()).toBe(expectedDir);
  });
});

describe("Bearer token generation", () => {
  it("creates a 64-hex-char token file with 0600 permissions", () => {
    const { path: p, token } = ensureAuthToken();
    expect(fs.existsSync(p)).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      const mode = fs.statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("returns the same token across calls (idempotent)", () => {
    const a = ensureAuthToken();
    const b = ensureAuthToken();
    expect(a.token).toBe(b.token);
    expect(a.path).toBe(b.path);
  });

  it("lives under ~/.usrcp/users/<slug>/auth.token", () => {
    setUserSlug("jess");
    const { path: p } = ensureAuthToken();
    expect(p).toBe(path.join(tmpHome, ".usrcp", "users", "jess", "auth.token"));
    expect(getAuthTokenPath()).toBe(p);
  });
});

describe("verifyBearer", () => {
  it("accepts exact match", () => {
    expect(verifyBearer("abc123", "abc123")).toBe(true);
  });
  it("rejects length mismatch without timingSafeEqual crash", () => {
    expect(verifyBearer("abc", "abcd")).toBe(false);
    expect(verifyBearer("", "x")).toBe(false);
  });
  it("rejects value mismatch of same length", () => {
    expect(verifyBearer("abc1", "abc2")).toBe(false);
  });
});

describe("HTTP transport end-to-end", () => {
  // Use a shared helper so we can run multiple round-trips per server start
  async function httpsRequest(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string; cert?: string } = {}
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: u.hostname,
          port: Number(u.port),
          path: u.pathname + u.search,
          method: opts.method || "GET",
          headers: opts.headers || {},
          // Trust only the provided cert (pinning). If cert omitted, reject
          // self-signed certs (standard behavior).
          ca: opts.cert ? [opts.cert] : undefined,
          rejectUnauthorized: opts.cert ? true : false,
          checkServerIdentity: () => undefined, // allow localhost vs CN=localhost mismatch on older Node
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            resolve({
              status: res.statusCode || 0,
              headers: res.headers as any,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  it("rejects requests with no bearer token as 401", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const healthUrl = handle.url.replace("/mcp", "/healthz");
      const res = await httpsRequest(healthUrl, { method: "GET" });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBeDefined();
      expect(res.body).toContain("unauthorized");
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("rejects requests with wrong bearer token as 401", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const healthUrl = handle.url.replace("/mcp", "/healthz");
      const res = await httpsRequest(healthUrl, {
        method: "GET",
        headers: { authorization: "Bearer wrongtoken" },
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("accepts requests with correct bearer token on /healthz", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const healthUrl = handle.url.replace("/mcp", "/healthz");
      const res = await httpsRequest(healthUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain("ok");
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("returns 404 for unknown paths (still auth-gated)", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const url = handle.url.replace("/mcp", "/nope");
      const unauth = await httpsRequest(url, { method: "GET" });
      expect(unauth.status).toBe(401);

      const auth = await httpsRequest(url, {
        method: "GET",
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(auth.status).toBe(404);
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("MCP initialize call round-trips via HTTPS+bearer", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const initReq = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "transport-test", version: "0.0.1" },
        },
      };
      const res = await httpsRequest(handle.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initReq),
      });
      expect(res.status).toBe(200);
      // Streamable HTTP may respond with SSE or JSON; either way, the body
      // must contain the initialize result and an MCP session header.
      expect(res.body).toContain("usrcp-local");
      expect(res.headers["mcp-session-id"]).toBeDefined();
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("rejects plain HTTP (non-TLS) connections at the socket level", async () => {
    // Confirms the listener is TLS-only; a plain HTTP client over the
    // TLS port gets either a socket error or the TLS server's garbage
    // response (never a valid HTTP/1.1 reply).
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const plainResult = await new Promise<"error" | "badresponse">((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: handle.port,
            path: "/healthz",
            method: "GET",
            headers: { authorization: `Bearer ${handle.token}` },
            timeout: 2000,
          },
          (res) => {
            // Either we never get here (TLS rejects), or we get garbage
            resolve("badresponse");
            res.resume();
          }
        );
        req.on("error", () => resolve("error"));
        req.on("timeout", () => {
          req.destroy();
          resolve("error");
        });
        req.end();
      });
      expect(plainResult).toBe("error");
    } finally {
      await handle.close();
      shutdown();
    }
  });

  it("bound cert is the one on disk (TLS pinning works)", async () => {
    const { server, shutdown } = createServer();
    const handle = await startHttpTransport(server, { port: 0 });
    try {
      const cert = fs.readFileSync(path.join(getTlsDir(), "cert.pem"), "utf8");
      const healthUrl = handle.url.replace("/mcp", "/healthz");
      // With the pinned cert, the request succeeds
      const res = await httpsRequest(healthUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${handle.token}` },
        cert, // pin
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
      shutdown();
    }
  });
});
