import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getUserDir, safeWriteFile } from "./encryption.js";

// Max request body size (64 KiB). MCP messages are JSON; large payloads
// are a red flag and would bloat memory.
const MAX_BODY_BYTES = 64 * 1024;

export interface TlsMaterial {
  certPath: string;
  keyPath: string;
  cert: string;
  key: string;
}

export function getTlsDir(): string {
  return path.join(getUserDir(), "tls");
}

export function getAuthTokenPath(): string {
  return path.join(getUserDir(), "auth.token");
}

/**
 * Ensure a self-signed TLS certificate exists for localhost. Stored at
 * ~/.usrcp/users/<slug>/tls/{cert,key}.pem with mode 0600. Regenerates
 * only when missing — existing certs are left alone so clients don't
 * keep re-pinning.
 *
 * The cert is valid for 'localhost' and 127.0.0.1 via SAN. It is NOT
 * a public-CA cert; clients must be told to accept this specific cert
 * (or disable verification for this endpoint only).
 */
export async function ensureTlsCert(): Promise<TlsMaterial> {
  const dir = getTlsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      certPath,
      keyPath,
      cert: fs.readFileSync(certPath, "utf8"),
      key: fs.readFileSync(keyPath, "utf8"),
    };
  }

  // selfsigned is CJS-only with a promise-style generate().
  const selfsigned = await import("selfsigned");
  const pems = await (selfsigned as any).generate(
    [{ name: "commonName", value: "localhost" }],
    {
      days: 365,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
          ],
        },
      ],
    }
  );

  safeWriteFile(certPath, Buffer.from(pems.cert, "utf8"), 0o600);
  safeWriteFile(keyPath, Buffer.from(pems.private, "utf8"), 0o600);

  return { certPath, keyPath, cert: pems.cert, key: pems.private };
}

/**
 * Ensure a 32-byte random bearer token exists on disk. Stored hex-encoded
 * (64 chars) at ~/.usrcp/users/<slug>/auth.token, mode 0600. Regenerates
 * only when missing.
 */
export function ensureAuthToken(): { path: string; token: string } {
  fs.mkdirSync(getUserDir(), { recursive: true, mode: 0o700 });
  const p = getAuthTokenPath();
  if (fs.existsSync(p)) {
    const token = fs.readFileSync(p, "utf8").trim();
    if (token.length >= 32) return { path: p, token };
    // Too short — regenerate (backwards compatibility with test state)
  }
  const token = crypto.randomBytes(32).toString("hex");
  safeWriteFile(p, Buffer.from(token, "utf8"), 0o600);
  return { path: p, token };
}

/**
 * Constant-time bearer token comparison. Accepts tokens with the
 * expected length only. Any mismatch (length or bytes) returns false.
 */
export function verifyBearer(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface HttpTransportHandle {
  port: number;
  url: string;
  token: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown | undefined> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Start the MCP server on an authenticated HTTPS transport.
 *
 * Endpoint: https://<host>:<port>/mcp
 * Auth:     Authorization: Bearer <token>
 *
 * The returned handle exposes the bound port (useful when port=0 is
 * passed for tests), the full URL, and the bearer token. Call close()
 * for clean shutdown.
 */
export async function startHttpTransport(
  server: McpServer,
  opts: { port?: number; host?: string } = {}
): Promise<HttpTransportHandle> {
  const tls = await ensureTlsCert();
  const { token } = ensureAuthToken();

  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(mcpTransport);

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Bearer auth check — before anything else
    const authHeader = req.headers["authorization"];
    const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!verifyBearer(provided, token)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.setHeader("www-authenticate", "Bearer realm=\"usrcp\"");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Health endpoint for probes — auth-gated
    if (req.method === "GET" && req.url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const url = req.url || "";
    if (!url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    try {
      const body = await readBody(req);
      await mcpTransport.handleRequest(req, res, body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal", message: err?.message ?? "unknown" }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  };

  const httpsServer = https.createServer(
    { cert: tls.cert, key: tls.key },
    (req, res) => {
      requestHandler(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "internal", message: err?.message ?? "unknown" }));
        }
      });
    }
  );

  await new Promise<void>((resolve, reject) => {
    httpsServer.once("error", reject);
    httpsServer.listen(port, host, () => {
      httpsServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpsServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port: actualPort,
    url: `https://${host}:${actualPort}/mcp`,
    token,
    close: async () => {
      try { await mcpTransport.close(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    },
  };
}
