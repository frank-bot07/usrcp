import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, "..");
const PACKAGE_DIR = path.resolve(SRC_DIR, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PACKAGE_DIR, relativePath), "utf8");
}

describe("MAIN-world injection architecture", () => {
  it("injects the self-contained hook atomically without a named window handoff", () => {
    const worker = read("src/service-worker.ts");
    const hook = read("src/page-hook.ts");

    expect(worker).toContain("func: installPageHook");
    expect(worker).not.toContain('files: ["page-hook.js"]');
    expect(worker).not.toContain("__USRCP_INSTALL_HOOK__");
    expect(hook).not.toContain("__USRCP_INSTALL_HOOK__");
  });

  it("keeps the unpacked Chrome manifest version aligned with the npm package", () => {
    const pkg = JSON.parse(read("package.json"));
    const manifest = JSON.parse(read("manifest.json"));

    expect(manifest.version).toBe(pkg.version);
  });
});
