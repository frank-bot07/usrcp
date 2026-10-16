import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setUserSlug } from "usrcp-core/encryption";
import { atomicWrite, readOrNull, serverCommand } from "../adapters/terminal/shared.js";
import { auditConnections } from "../doctor.js";
import { getAntigravityConfigPath, register as registerAntigravity } from "../adapters/terminal/antigravity.js";
import { parse } from "jsonc-parser";
import { register as registerOpenCode, unregister as unregisterOpenCode } from "../adapters/terminal/opencode.js";
import { register as registerCursor } from "../adapters/terminal/cursor.js";
let home: string; let previous: string | undefined;
beforeEach(() => { previous = process.env.HOME; home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-connect-")); process.env.HOME = home; setUserSlug("rehearsal"); });
afterEach(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; setUserSlug("default"); fs.rmSync(home, { recursive: true, force: true }); });
describe("connection reliability", () => {
  it("prefers Antigravity's current config but supports an existing legacy installation", async () => {
    const legacy = path.join(home, ".gemini/antigravity/mcp_config.json");
    const current = path.join(home, ".gemini/config/mcp_config.json");
    expect(getAntigravityConfigPath()).toBe(current);
    fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, "{}");
    expect(getAntigravityConfigPath()).toBe(legacy);
    await registerAntigravity("/test/index.js");
    expect(JSON.parse(fs.readFileSync(legacy,"utf8")).mcpServers.usrcp.args).toContain("--user=rehearsal");
    fs.mkdirSync(path.dirname(current), { recursive: true }); fs.writeFileSync(current, "{}");
    expect(getAntigravityConfigPath()).toBe(current);
  });
  it("preserves OpenCode JSONC comments and unrelated servers when connecting and removing", async () => {
    const dir = path.join(home, "xdg", "opencode");
    vi.stubEnv("XDG_CONFIG_HOME", path.dirname(dir));
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "opencode.jsonc");
      fs.writeFileSync(file, '{ // keep this comment\n "mcp": {"other": {"type":"local", "command":["other"]},},}');
      await registerOpenCode("/opt/usrcp/index.js");
      let raw = fs.readFileSync(file, "utf8");
      expect(raw).toContain("// keep this comment");
      expect(parse(raw).mcp.usrcp.command).toContain("--user=rehearsal");
      expect(fs.existsSync(path.join(dir, "opencode.json"))).toBe(false);
      await unregisterOpenCode();
      raw = fs.readFileSync(file, "utf8");
      expect(raw).toContain("// keep this comment");
      expect(parse(raw).mcp).toEqual({ other: { type: "local", command: ["other"] } });
    } finally { vi.unstubAllEnvs(); }
  });

  it("pins OpenCode to the selected profile instead of falling back after another profile is added", async () => {
    await registerOpenCode("/opt/usrcp/index.js");
    const entry = JSON.parse(fs.readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8")).mcp.usrcp;
    expect(entry.command).toEqual([process.execPath, "/opt/usrcp/index.js", "serve", "--stdio", "--user=rehearsal", "--agent-id=opencode"]);
  });
  it("reconnecting preserves credentials, host approvals and process restrictions", async () => {
    const file = path.join(home, ".cursor/mcp.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { usrcp: { command: "/old/usrcp", args: ["serve", "--user=old", "--readonly", "--read-scopes", "coding", "--no-audit", "--agent-id=restricted"], env: { SECRET_TEST: "synthetic" }, autoApprove: [] }, other: { command: "untouched" } } }));
    await registerCursor("/new/index.js");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers;
    expect(entries.usrcp.env).toEqual({ SECRET_TEST: "synthetic" });
    expect(entries.usrcp.autoApprove).toEqual([]);
    expect(entries.usrcp.args).toEqual(expect.arrayContaining(["--user=rehearsal", "--readonly", "--read-scopes=coding", "--no-audit", "--agent-id=restricted"]));
    expect(entries.other.command).toBe("untouched");
  });
  it("does not mistake an unreadable config for a missing one", async () => {
    await expect(readOrNull(home)).rejects.toThrow();
    expect(await readOrNull(path.join(home, "absent"))).toBeNull();
  });
  it("backs up secrets with private permissions and distinct names", async () => {
    const file = path.join(home, "config.json");
    await atomicWrite(file, "{}", "json", "test", "secret-old");
    await atomicWrite(file, "{}", "json", "test", "secret-old");
    const dir = path.join(home, ".usrcp/backups"); const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);
    if (process.platform !== "win32") for (const name of files) expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
  });
  it("diagnoses the actual missing-profile and stale-script failure modes without reading memory", async () => {
    const file = path.join(home, ".cursor/mcp.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { usrcp: { command: process.execPath, args: ["/missing/index.js", "serve"] } } }));
    const report = (await auditConnections({ home })).find(r => r.host === "cursor")!;
    expect(report.state).toBe("failed"); expect(report.issues.join(" ")).toContain("profile"); expect(report.issues.join(" ")).toContain("missing");
  });
  it("rejects malformed existing restrictions instead of silently widening access", () => {
    expect(() => serverCommand("/usrcp", ["serve"], { args: ["--read-scopes"] })).toThrow();
  });
});
