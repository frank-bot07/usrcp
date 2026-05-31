import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(TEST_DIR, "..", "..");
const BRIDGE_PATH = path.join(PACKAGE_DIR, "native-host", "usrcp-bridge.cjs");
const LOCAL_CLI_PATH = path.resolve(PACKAGE_DIR, "..", "usrcp-local", "dist", "index.js");

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

describe("native-host framing", () => {
  it("handles a header and JSON body delivered in one stdin write", async () => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`native host did not respond before timeout: ${stderr}`));
      }, 2_000);
      let stdout = Buffer.alloc(0);

      child.stdout.on("data", (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length < 4) return;
        const length = stdout.readUInt32LE(0);
        if (stdout.length < 4 + length) return;
        clearTimeout(timer);
        resolve(JSON.parse(stdout.subarray(4, 4 + length).toString("utf8")));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (code && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`native host exited with code ${code}: ${stderr}`));
        }
      });

      child.stdin.end(frame({ op: "ping" }));
    });

    expect(response).toEqual({ op: "pong" });
  });

  it("rejects a truncated message at EOF", async () => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(100, 0);
    child.stdin.end(Buffer.concat([header, Buffer.from("{}")]));

    expect(await exited).toBe(1);
    expect(stderr).toContain("Incomplete native message at EOF");
  });

  it("appends and retrieves a captured turn through the real bridge", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-extension-native-host-"));
    const env = { ...process.env, HOME: home };
    execFileSync(process.execPath, [LOCAL_CLI_PATH, "init", "--dev"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    fs.writeFileSync(
      path.join(home, ".usrcp", "extension-config.json"),
      JSON.stringify({ allowed_domains: ["claude.ai"] })
    );
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    const responses: Array<(response: Record<string, unknown>) => void> = [];
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      while (stdout.length >= 4) {
        const length = stdout.readUInt32LE(0);
        if (stdout.length < 4 + length) return;
        const response = JSON.parse(stdout.subarray(4, 4 + length).toString("utf8"));
        stdout = stdout.subarray(4 + length);
        responses.shift()?.(response);
      }
    });
    const send = (message: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`native host did not respond before timeout: ${stderr}`));
        }, 2_000);
        responses.push((response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(frame(message));
      });

    try {
      const marker = `USRCP_BRIDGE_TEST_${Date.now()}`;
      const append = await send({
        op: "ledger.append",
        turn: { id: marker, role: "user", content: marker },
      });
      const search = await send({
        op: "memory.search",
        q: marker,
        limit: 5,
        requestId: "test",
      });

      expect(append).toMatchObject({ op: "ledger.append.result", ok: true });
      expect(search).toMatchObject({ op: "memory.search.result", requestId: "test" });
      expect(search.snippets).toEqual([expect.stringContaining(marker)]);
    } finally {
      child.stdin.end();
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
