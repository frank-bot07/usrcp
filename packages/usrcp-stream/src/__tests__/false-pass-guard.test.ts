import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Codex P0-3: subprocess mutation harness. For each "load-bearing"
// implementation file, this test:
//   1. Saves the original source.
//   2. Patches a specific substring to a known no-op.
//   3. Spawns a child `vitest run <target test file>`.
//   4. Asserts the subprocess exits non-zero (i.e. the targeted test
//      did fail because of the mutation).
//   5. Restores the original source in a finally block.
//
// If any mutation slips through and the targeted test still passes, the
// suite as a whole is at risk of the PR #24 trap: tests that pass for
// the wrong reason. Each row below is one such trap closed.

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const VITEST_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "vitest");

interface MutationCase {
  name: string;
  file: string;
  find: string;
  replace: string;
  targetTest: string;
}

const MUTATIONS: MutationCase[] = [
  {
    name: "no-op encrypt breaks encrypted-rows tests",
    file: "src/db/encrypted-row.ts",
    find: "return _encrypt(plaintext, keyFor(masterKey, table));",
    replace: "return plaintext;",
    targetTest: "src/__tests__/encrypted-rows.test.ts",
  },
  {
    name: "broken events INSERT breaks capture-bidirectional tests",
    file: "src/capture/ingest.ts",
    find: "INSERT INTO events",
    replace: "INSERT INTO no_such_table_mutation_xyz",
    targetTest: "src/__tests__/capture-bidirectional.test.ts",
  },
  {
    name: "no-op vectorSearch breaks mcp-tools recall test",
    file: "src/vector/search.ts",
    find: "if (!tableExists) return [];",
    replace: "if (true) return [];",
    targetTest: "src/__tests__/mcp-tools.test.ts",
  },
  {
    name: "stitch-disable breaks stitch-cross-surface tests",
    file: "src/stitch/thread.ts",
    find: "if (best && best.s >= config.link_threshold) {",
    replace: "if (false) {",
    targetTest: "src/__tests__/stitch-cross-surface.test.ts",
  },
];

const pendingRestores: Map<string, string> = new Map();

function abs(rel: string): string {
  return path.join(PACKAGE_ROOT, rel);
}

function applyMutation(mut: MutationCase): void {
  const original = fs.readFileSync(abs(mut.file), "utf-8");
  if (!original.includes(mut.find)) {
    throw new Error(
      `Mutation '${mut.name}' pattern not found in ${mut.file}.\nLooked for: ${mut.find}`
    );
  }
  if (pendingRestores.has(mut.file)) {
    throw new Error(`Refusing to double-mutate ${mut.file} mid-run`);
  }
  pendingRestores.set(mut.file, original);
  fs.writeFileSync(abs(mut.file), original.replace(mut.find, mut.replace), "utf-8");
}

function restore(file: string): void {
  const original = pendingRestores.get(file);
  if (original === undefined) return;
  fs.writeFileSync(abs(file), original, "utf-8");
  pendingRestores.delete(file);
}

function restoreAll(): void {
  for (const [file, original] of pendingRestores.entries()) {
    fs.writeFileSync(abs(file), original, "utf-8");
  }
  pendingRestores.clear();
}

// Belt-and-suspenders: if the parent test process is killed mid-run, the
// SIGINT handler restores files before we die. Vitest itself handles
// SIGINT but the cleanup ordering between vitest and our test isn't
// guaranteed; do not rely on afterAll alone for safety.
function installSignalGuard(): void {
  const handler = () => {
    try {
      restoreAll();
    } catch {
      // best-effort
    }
  };
  process.once("SIGINT", () => {
    handler();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    handler();
    process.exit(143);
  });
}

installSignalGuard();

afterAll(() => {
  restoreAll();
});

function runSubprocessVitest(testFile: string): {
  status: number | null;
  output: string;
} {
  // Strip VITEST_POOL_ID / VITEST_WORKER_ID so the child doesn't try to
  // rejoin the parent vitest's worker pool.
  const childEnv = { ...process.env, CI: "1" };
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  const result = spawnSync(VITEST_BIN, ["run", "--no-coverage", testFile], {
    cwd: PACKAGE_ROOT,
    timeout: 90_000,
    stdio: "pipe",
    encoding: "utf-8",
    env: childEnv,
  });
  return {
    status: result.status,
    output: (result.stdout || "") + (result.stderr || ""),
  };
}

describe("false-pass mutation harness (Codex P0-3)", () => {
  for (const mut of MUTATIONS) {
    it(`detects: ${mut.name}`, () => {
      applyMutation(mut);
      let result: ReturnType<typeof runSubprocessVitest>;
      try {
        result = runSubprocessVitest(mut.targetTest);
      } finally {
        restore(mut.file);
      }
      if (result.status === 0) {
        // Surface the subprocess output so a future maintainer can see
        // why the mutation didn't actually break anything.
        throw new Error(
          `Mutation '${mut.name}' did NOT cause ${mut.targetTest} to fail. ` +
            `The targeted test passes despite the load-bearing code being broken; ` +
            `this means the test is not really validating that path.\n\n` +
            `--- subprocess output ---\n${result.output}`
        );
      }
    }, 120_000);
  }
});
