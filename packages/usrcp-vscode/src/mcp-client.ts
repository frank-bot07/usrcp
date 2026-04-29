/**
 * MCP client wrapper for the USRCP local server.
 *
 * Spawns `usrcp serve --transport=stdio` and exposes typed helpers for the
 * read-only tools the TreeView needs. All write tools (set_fact,
 * append_event, etc.) are intentionally not surfaced — the human-facing
 * UI is read-only by design (see project_usrcp_autonomous_writes memory).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface UsrcpStatus {
  total_events: number;
  total_projects: number;
  domains: string[];
  platforms: string[];
  db_size_bytes: number;
  audit_log_entries: number;
  encryption_enabled: boolean;
}

export interface UsrcpFact {
  domain: string;
  namespace: string;
  key: string;
  value: unknown;
  updated_at?: string;
}

export class BinaryNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `usrcp binary not found. Searched: ${searched.join(", ")}. ` +
        `Install via Homebrew (\`brew install frank-bot07/usrcp/usrcp\`) ` +
        `or set "usrcp.binaryPath" in VS Code settings.`,
    );
    this.name = "BinaryNotFoundError";
  }
}

const FALLBACK_PATHS = [
  "/opt/homebrew/bin/usrcp",
  "/usr/local/bin/usrcp",
  () => join(homedir(), ".local", "bin", "usrcp"),
];

/**
 * Resolve the path to the `usrcp` binary.
 *
 * Order: explicit setting → `which usrcp` on PATH → common install paths.
 * Throws BinaryNotFoundError listing what was tried so the user can fix it.
 */
export function resolveUsrcpBinary(configured?: string): string {
  const tried: string[] = [];

  if (configured && configured.trim().length > 0) {
    tried.push(configured);
    if (existsSync(configured)) return configured;
  }

  try {
    const out = execSync("which usrcp", { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
    if (out && existsSync(out)) return out;
    if (out) tried.push(out);
  } catch {
    tried.push("$PATH (which usrcp)");
  }

  for (const candidate of FALLBACK_PATHS) {
    const p = typeof candidate === "function" ? candidate() : candidate;
    tried.push(p);
    if (existsSync(p)) return p;
  }

  throw new BinaryNotFoundError(tried);
}

export interface ConnectOptions {
  binaryPath?: string;
  user?: string;
}

export class UsrcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async connect(opts: ConnectOptions = {}): Promise<void> {
    const bin = resolveUsrcpBinary(opts.binaryPath);
    const args = ["serve", "--transport=stdio"];
    if (opts.user && opts.user.trim().length > 0) {
      args.push(`--user=${opts.user.trim()}`);
    }

    this.transport = new StdioClientTransport({
      command: bin,
      args,
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "usrcp-vscode", version: "0.1.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
  }

  async dispose(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best-effort
    }
    this.client = null;
    this.transport = null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async getStatus(): Promise<UsrcpStatus> {
    const result = await this.callTool("usrcp_status", {});
    return parseToolResult<UsrcpStatus>(result);
  }

  /**
   * List facts in a domain (no key filter — returns all facts in domain,
   * optionally filtered by namespace).
   */
  async listFacts(domain: string, namespace?: string): Promise<UsrcpFact[]> {
    const args: Record<string, unknown> = { domain };
    if (namespace) args.namespace = namespace;
    const result = await this.callTool("usrcp_get_facts", args);
    const parsed = parseToolResult<{ count: number; facts: UsrcpFact[] }>(result);
    return parsed.facts ?? [];
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("UsrcpClient not connected");
    return this.client.callTool({ name, arguments: args });
  }
}

/**
 * Parse the tool result envelope ({ content: [{ type: "text", text: "..." }] })
 * into a typed payload. Each USRCP tool returns JSON-stringified data.
 */
function parseToolResult<T>(result: unknown): T {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP tool returned no content");
  }
  const text = content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("MCP tool returned non-text content");
  }
  return JSON.parse(text) as T;
}
