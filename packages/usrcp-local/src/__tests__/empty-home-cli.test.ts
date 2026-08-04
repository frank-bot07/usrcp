import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Regression for #194. #183 routed adapter paths through requireHomeDir(), and
 * init/serve/adapter-list refuse cleanly under empty HOME. But `status` and
 * `users` (and `config`, the same class) reach migrateLegacyLayout() ->
 * requireHomeDir(), and their dispatch was synchronous with no `.catch`, so the
 * throw escaped as an uncaught exception with a full stack trace instead of the
 * one-line refusal + exit 1 that every async command gets.
 *
 * These commands now dispatch async into the shared Fatal handler. We drive the
 * real built CLI so the assertion is against dispatch behavior, not an internal
 * function.
 */
describe("empty HOME: status/users/config refuse cleanly, not with a stack trace (#194)", () => {
  const distIndex = path.resolve(__dirname, "..", "..", "dist", "index.js");

  beforeAll(() => {
    if (!fs.existsSync(distIndex)) {
      execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "..", ".."), stdio: "ignore" });
    }
  });

  function runWithEmptyHome(command: string): { status: number; stderr: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-emptyhome-cli-"));
    try {
      execFileSync(process.execPath, [distIndex, command], {
        // Empty HOME is the trigger; USERPROFILE cleared too so os.homedir()
        // can't fall back to it on any platform.
        env: { ...process.env, HOME: "", USERPROFILE: "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      return { status: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      return { status: e.status ?? -1, stderr: e.stderr?.toString() ?? "" };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  for (const command of ["status", "users", "config"]) {
    it(`\`usrcp ${command}\` exits 1 with a one-line HOME refusal and no stack trace`, () => {
      const { status, stderr } = runWithEmptyHome(command);
      expect(status).toBe(1);
      expect(stderr).toMatch(/HOME is unset or empty/);
      // The bug was an uncaught exception: Node prints "at <frame>" stack lines
      // and the file path of the throw site. The clean refusal has neither.
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stderr).not.toContain("encryption.js");
    });
  }
});
