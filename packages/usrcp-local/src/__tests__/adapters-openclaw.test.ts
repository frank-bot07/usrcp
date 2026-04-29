/**
 * Unit tests for the OpenClaw adapter setup module.
 *
 * The wizard does not shell out — it prints a copy-paste command. Tests
 * inject stubs for the usrcp-bin resolver and the passphrase-mode probe,
 * then capture stdout via the `log` dependency to assert the printed
 * command is well-formed and contains the expected fields.
 */

import { describe, it, expect } from "vitest";
import {
  buildOpenclawMcpServerEntry,
  buildOpenclawMcpSetCommand,
  runOpenclawSetup,
} from "../adapters/openclaw/setup.js";

describe("buildOpenclawMcpServerEntry", () => {
  it("dev mode entry has command + args, no env", () => {
    const entry = buildOpenclawMcpServerEntry("/usr/local/bin/usrcp", false);
    expect(entry).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
    expect(entry.env).toBeUndefined();
  });

  it("passphrase mode entry includes USRCP_PASSPHRASE placeholder", () => {
    const entry = buildOpenclawMcpServerEntry("/usr/local/bin/usrcp", true);
    expect(entry.env).toEqual({ USRCP_PASSPHRASE: "<your passphrase>" });
  });
});

describe("buildOpenclawMcpSetCommand", () => {
  it("emits a single-quoted JSON arg that round-trips through JSON.parse", () => {
    const entry = buildOpenclawMcpServerEntry("/opt/homebrew/bin/usrcp", false);
    const cmd = buildOpenclawMcpSetCommand(entry);
    expect(cmd.startsWith("openclaw mcp set usrcp '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    const json = cmd.slice("openclaw mcp set usrcp '".length, -1);
    expect(JSON.parse(json)).toEqual(entry);
  });

  it("JSON payload is single-line (no embedded newlines that would break shell)", () => {
    const entry = buildOpenclawMcpServerEntry("/usr/local/bin/usrcp", true);
    const cmd = buildOpenclawMcpSetCommand(entry);
    expect(cmd).not.toContain("\n");
  });
});

describe("runOpenclawSetup", () => {
  it("dev mode: prints the openclaw mcp set command with the resolved usrcp bin", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => false,
      whichOpenclaw: () => "/usr/local/bin/openclaw",
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("openclaw mcp set usrcp '");
    expect(output).toContain("/usr/local/bin/usrcp");
    expect(output).toContain('"args":["serve","--stdio"]');
    // No passphrase warning when running in dev mode
    expect(output).not.toContain("Passphrase mode detected");
    // No env block in the command itself
    expect(output).not.toContain("USRCP_PASSPHRASE");
  });

  it("passphrase mode: prints the warning and includes the env placeholder in the command", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => true,
      whichOpenclaw: () => "/usr/local/bin/openclaw",
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("Passphrase mode detected");
    expect(output).toContain("Replace <your passphrase>");
    expect(output).toContain('"env":{"USRCP_PASSPHRASE":"<your passphrase>"}');
  });

  it("prints verify and removal hints", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => false,
      whichOpenclaw: () => "/usr/local/bin/openclaw",
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("openclaw mcp list");
    expect(output).toContain("openclaw mcp unset usrcp");
  });

  it("always prints the OpenClaw install prerequisite + docs URL", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => false,
      whichOpenclaw: () => "/usr/local/bin/openclaw",
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("Prerequisite: OpenClaw must already be installed");
    expect(output).toContain("https://docs.openclaw.ai/start/getting-started");
  });

  it("openclaw on PATH: prints the resolved binary path", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => false,
      whichOpenclaw: () => "/opt/homebrew/bin/openclaw",
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("Found openclaw at /opt/homebrew/bin/openclaw");
    // Missing-binary warning must NOT appear when the probe found it
    expect(output).not.toContain("`openclaw` was not found on your PATH");
  });

  it("openclaw missing from PATH: prints the warning but still emits the command", async () => {
    const lines: string[] = [];
    await runOpenclawSetup({
      resolveUsrcpBin: () => "/usr/local/bin/usrcp",
      isPassphraseMode: () => false,
      whichOpenclaw: () => null,
      log: (l) => lines.push(l),
    });

    const output = lines.join("\n");
    expect(output).toContain("`openclaw` was not found on your PATH");
    expect(output).toContain("openclaw mcp set usrcp '");
    expect(output).not.toContain("Found openclaw at");
  });
});
