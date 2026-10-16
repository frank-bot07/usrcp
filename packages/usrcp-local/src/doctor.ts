import { parse as parseJsonc, type ParseError } from "jsonc-parser";
/** Read-only configuration audit. Probing initializes MCP and lists tools; it never reads user context. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAntigravityConfigPath } from "./adapters/terminal/antigravity.js";
import TOML from "@iarna/toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireHomeDir } from "usrcp-core/encryption";

export interface ConnectionReport {
  host: string; entry: string; config: string;
  state: "missing" | "invalid" | "configured" | "protocol-ready" | "failed";
  issues: string[]; version?: string; tools?: number;
}
interface Source { host: string; file: string; key?: string; toml?: boolean }
export function connectionSources(home: string): Source[] {
  const code = process.platform === "darwin" ? path.join(home, "Library/Application Support/Code")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "Code")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code");
  const claude = process.platform === "darwin" ? path.join(home, "Library/Application Support/Claude")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "Claude")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
  return [
    { host: "claude-desktop", file: path.join(claude, "claude_desktop_config.json"), key: "mcpServers" },
    { host: "claude-code", file: path.join(home, ".claude.json"), key: "mcpServers" },
    { host: "cursor", file: path.join(home, ".cursor/mcp.json"), key: "mcpServers" },
    { host: "codex", file: path.join(home, ".codex/config.toml"), key: "mcp_servers", toml: true },
    { host: "opencode", file: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), fs.existsSync(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode/opencode.jsonc")) ? "opencode/opencode.jsonc" : "opencode/opencode.json"), key: "mcp" },
    { host: "antigravity", file: getAntigravityConfigPath(home), key: "mcpServers" },
    { host: "copilot-cli", file: path.join(home, ".copilot/mcp-config.json"), key: "mcpServers" },
    { host: "cline", file: path.join(code, "User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"), key: "mcpServers" },
    { host: "continue", file: path.join(home, ".continue/mcpServers/usrcp.json") },
  ];
}
function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const equal = args.find(a => a.startsWith(prefix));
  if (equal) return equal.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}
export async function auditConnections(opts: { home?: string; probe?: boolean; timeoutMs?: number } = {}): Promise<ConnectionReport[]> {
  const home = opts.home ?? requireHomeDir();
  const reports: ConnectionReport[] = [];
  for (const source of connectionSources(home)) {
    const base = { host: source.host, config: source.file, entry: "usrcp" };
    let doc: any;
    try {
      const raw = fs.readFileSync(source.file, "utf8");
      const errors: ParseError[] = [];
      doc = source.toml ? TOML.parse(raw) : parseJsonc(raw, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error("Invalid configuration");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reports.push({ ...base, state: missing ? "missing" : "invalid", issues: missing ? [] : ["Configuration is unreadable or malformed; it was not modified."] });
      continue;
    }
    const entries = source.key ? doc?.[source.key] : { usrcp: doc };
    const found = entries && typeof entries === "object" && !Array.isArray(entries)
      ? Object.entries(entries).filter(([name]) => name === "usrcp" || name.startsWith("usrcp-")) : [];
    if (!found.length) { reports.push({ ...base, state: "missing", issues: [] }); continue; }
    for (const [name, raw] of found) {
      const report: ConnectionReport = { ...base, entry: name, state: "configured", issues: [] };
      reports.push(report);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { report.state = "invalid"; report.issues.push("Invalid MCP entry."); continue; }
      const entry = raw as Record<string, any>;
      if (entry.enabled === false || entry.disabled === true) report.issues.push("Connection is disabled in this host.");
      const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
      const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args ?? [];
      if (typeof command !== "string" || !Array.isArray(args) || !args.every(a => typeof a === "string")) {
        report.state = "invalid"; report.issues.push("A local command and string arguments are required; remote transports are not probed by this command."); continue;
      }
      if (!path.isAbsolute(command)) report.issues.push("Executable depends on the host PATH; use an absolute executable path.");
      else if (!fs.existsSync(command)) report.issues.push("Configured executable no longer exists.");
      const script = args.find(a => /\.[cm]?js$/i.test(a));
      if (script && (!path.isAbsolute(script) || !fs.existsSync(script))) report.issues.push("Configured JavaScript entrypoint is missing or relative.");
      if (!flag(args, "user")) report.issues.push("No explicit user profile: adding another profile can break this connection. Re-register with --user=<profile>.");
      if (report.issues.length) { report.state = "failed"; continue; }
      if (!opts.probe) continue;
      const extraEnv = entry.env ?? entry.environment ?? {};
      if (!extraEnv || typeof extraEnv !== "object" || Array.isArray(extraEnv) || !Object.values(extraEnv).every(v => typeof v === "string")) {
        report.state = "invalid"; report.issues.push("Environment values must be strings."); continue;
      }
      const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
      const transport = new StdioClientTransport({ command, args, env: { ...env, HOME: home, ...extraEnv }, stderr: "pipe" });
      const client = new Client({ name: "usrcp-doctor", version: "1.0.0" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), opts.timeoutMs ?? 10000); });
        await Promise.race([client.connect(transport).then(async () => {
          const listed = await client.listTools();
          report.version = client.getServerVersion()?.version;
          report.tools = listed.tools.length;
          if (!listed.tools.some(t => t.name === "usrcp_handoff")) throw new Error("missing-handoff");
        }), deadline]);
        report.state = "protocol-ready";
      } catch {
        report.state = "failed";
        report.issues.push("MCP startup/tool discovery failed or timed out. Check installation, profile unlock and usrcp_handoff availability. No context was read.");
      } finally {
        clearTimeout(timer);
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    }
  }
  return reports;
}
