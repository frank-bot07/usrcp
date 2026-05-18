import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { createStreamCaptureClient } from "usrcp-stream/dist/capture-client.js";
import type { EmbeddingProvider } from "usrcp-stream/dist/embeddings/provider.js";
import { makeWatcher } from "../watcher.js";
import { encodeProjectDir, type ClaudeCodeConfig } from "../config.js";

class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake";
  async embed(text: string): Promise<Float32Array> {
    const h = crypto.createHash("sha256").update(text).digest();
    const v = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) v[i] = (h[i % h.length] / 255) * 2 - 1;
    return v;
  }
}

const PROJECT_A = "/work/proj-a";
const PROJECT_B = "/work/proj-b";

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let streamClient: ReturnType<typeof createStreamCaptureClient>;
let projectsRoot: string;
let projectADir: string;
let sessionFile: string;
let config: ClaudeCodeConfig;

function jsonl(line: unknown): string {
  return JSON.stringify(line) + "\n";
}

function userTurn(uuid: string, ts: string, content: string, cwd: string = PROJECT_A) {
  return {
    type: "user",
    uuid,
    sessionId: "s-1",
    timestamp: ts,
    cwd,
    isSidechain: false,
    message: { role: "user", content },
  };
}

function assistantTurn(uuid: string, ts: string, content: string, cwd: string = PROJECT_A) {
  return {
    type: "assistant",
    uuid,
    sessionId: "s-1",
    timestamp: ts,
    cwd,
    isSidechain: false,
    message: { role: "assistant", content, model: "claude-opus-4-7" },
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-claude-code-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  ledger = new Ledger(path.join(tmpHome, "ledger.db"));
  streamClient = createStreamCaptureClient(ledger.getMasterKey(), tmpHome, {
    ledger,
    embedder: new FakeEmbedder(),
  });
  projectsRoot = path.join(tmpHome, ".claude", "projects");
  projectADir = path.join(projectsRoot, encodeProjectDir(PROJECT_A));
  fs.mkdirSync(projectADir, { recursive: true });
  sessionFile = path.join(projectADir, "session-1.jsonl");
  config = {
    allowlisted_projects: [PROJECT_A],
    file_offsets: {},
  };
});

afterEach(() => {
  try { streamClient.close(); } catch { /* */ }
  try { ledger.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("watcher", () => {
  it("processes turn lines and advances offset, skipping non-turn lines", async () => {
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "hi")) +
        jsonl({ type: "queue-operation", operation: "enqueue", sessionId: "s-1", timestamp: "x", content: "..." }) +
        jsonl(assistantTurn("u2", "2026-05-15T17:00:10Z", "hello"))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();
    expect(stats.eventsCaptured).toBe(2);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.linesProcessed).toBe(3);
    expect(config.file_offsets[sessionFile]).toBe(fs.statSync(sessionFile).size);

    const rows = streamClient.handle.db
      .prepare("SELECT side FROM events ORDER BY ts_ms ASC")
      .all() as { side: string }[];
    expect(rows.map((r) => r.side)).toEqual(["outbound", "inbound"]);
  });

  it("re-tick after append processes only the new lines", async () => {
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "first"))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    await watcher.poll();
    const firstOffset = config.file_offsets[sessionFile];
    expect(firstOffset).toBe(fs.statSync(sessionFile).size);

    fs.appendFileSync(
      sessionFile,
      jsonl(assistantTurn("u2", "2026-05-15T17:00:30Z", "follow-up"))
    );
    const stats = await watcher.poll();
    expect(stats.eventsCaptured).toBe(1);
    expect(stats.linesProcessed).toBe(1);
    expect(config.file_offsets[sessionFile]).toBeGreaterThan(firstOffset);

    const count = streamClient.handle.db
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("handles file truncation: resets offset and re-scans", async () => {
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "hi")) +
        jsonl(assistantTurn("u2", "2026-05-15T17:00:30Z", "hello"))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    await watcher.poll();
    expect((streamClient.handle.db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c).toBe(2);

    // Replace the file with a shorter version (simulates truncation).
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u3", "2026-05-15T18:00:00Z", "fresh after truncation"))
    );
    const stats = await watcher.poll();
    expect(stats.truncationsDetected).toBe(1);
    expect(stats.eventsCaptured).toBe(1);
    expect(config.file_offsets[sessionFile]).toBe(fs.statSync(sessionFile).size);
    // Total events in stream is now 3 (2 originals + 1 post-truncation).
    expect((streamClient.handle.db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c).toBe(3);
  });

  it("leaves a partial trailing line for the next tick", async () => {
    const completeLine = jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "complete"));
    // Write a complete line + a partial (no trailing newline) JSON.
    fs.writeFileSync(sessionFile, completeLine + '{"type":"user","timestamp":"2026-05-15T17:00:30Z","cwd":"/work/proj-a","isSidechain":false,"message":{"role":"user","content":"partial');
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats1 = await watcher.poll();
    expect(stats1.eventsCaptured).toBe(1);
    expect(config.file_offsets[sessionFile]).toBe(Buffer.byteLength(completeLine, "utf-8"));

    // Finish the partial line on a subsequent write.
    fs.appendFileSync(sessionFile, '"}}\n');
    const stats2 = await watcher.poll();
    expect(stats2.eventsCaptured).toBe(1);
    expect(config.file_offsets[sessionFile]).toBe(fs.statSync(sessionFile).size);
  });

  it("never reads from a project that isn't allowlisted", async () => {
    const projectBDir = path.join(projectsRoot, encodeProjectDir(PROJECT_B));
    fs.mkdirSync(projectBDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectBDir, "off.jsonl"),
      jsonl(userTurn("u-b1", "2026-05-15T17:00:00Z", "from off-list project", PROJECT_B))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();
    expect(stats.filesScanned).toBe(0);
    expect(stats.eventsCaptured).toBe(0);
    expect(Object.keys(config.file_offsets)).toHaveLength(0);
  });

  it("ignores non-.jsonl files in the project dir (e.g. sessions-index.json)", async () => {
    fs.writeFileSync(path.join(projectADir, "sessions-index.json"), '{"sessions":[]}');
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "real turn"))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();
    expect(stats.eventsCaptured).toBe(1);
    expect(stats.filesScanned).toBe(1);
  });

  it("skips a project whose dir doesn't exist on disk yet", async () => {
    config.allowlisted_projects = ["/work/never-active"];
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();
    expect(stats.filesScanned).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("malformed JSON line is counted as an error but does not block subsequent valid lines", async () => {
    fs.writeFileSync(
      sessionFile,
      "not-valid-json{\n" +
        jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "after malformed")) +
        "}also-broken\n" +
        jsonl(assistantTurn("u2", "2026-05-15T17:00:30Z", "also captured"))
    );
    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();
    expect(stats.errors).toBeGreaterThanOrEqual(2);
    expect(stats.eventsCaptured).toBe(2);
  });

  // --- Offset pruning (PR #68 / Codex Tier-2 #5) ---

  it("prunes a file_offsets entry whose JSONL was deleted from disk", async () => {
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "live session"))
    );
    // Pre-populate file_offsets with a stale entry for a session
    // that no longer exists on disk (compacted by Claude Code, etc).
    const stale = path.join(projectADir, "session-old-gone.jsonl");
    config.file_offsets[stale] = 12345;

    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();

    expect(stats.offsetsPruned).toBe(1);
    expect(config.file_offsets).not.toHaveProperty(stale);
    // Live session still tracked with a fresh offset.
    expect(config.file_offsets[sessionFile]).toBeGreaterThan(0);
  });

  it("does NOT prune entries from a project dir that failed readdirSync (transient)", async () => {
    // Simulate a transient mount issue by allowlisting a project
    // whose directory does not exist on disk this tick. The
    // pre-existing offset entry for a file under that dir must
    // NOT be removed, because the directory might come back.
    const missingProject = "/work/proj-missing";
    config.allowlisted_projects = [PROJECT_A, missingProject];
    const missingDir = path.join(projectsRoot, encodeProjectDir(missingProject));
    const missingFile = path.join(missingDir, "session.jsonl");
    config.file_offsets[missingFile] = 999;

    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "from proj-a"))
    );

    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();

    expect(stats.offsetsPruned).toBe(0);
    expect(config.file_offsets[missingFile]).toBe(999);
  });

  it("does NOT prune an entry from a project dir that isn't allowlisted", async () => {
    // file_offsets might carry an entry from a previously-allowlisted
    // project that the user de-allowlisted. Don't drop those: the
    // user may re-allowlist, and we'd want to resume mid-stream
    // rather than re-scan the whole history.
    const formerlyAllowlistedDir = path.join(
      projectsRoot,
      encodeProjectDir("/work/proj-deallowlisted")
    );
    fs.mkdirSync(formerlyAllowlistedDir, { recursive: true });
    const formerlyFile = path.join(formerlyAllowlistedDir, "session.jsonl");
    fs.writeFileSync(formerlyFile, jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "old")));
    config.file_offsets[formerlyFile] = 50;

    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "live"))
    );

    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();

    expect(stats.offsetsPruned).toBe(0);
    expect(config.file_offsets[formerlyFile]).toBe(50);
  });

  it("prunes multiple stale entries in a single tick", async () => {
    fs.writeFileSync(
      sessionFile,
      jsonl(userTurn("u1", "2026-05-15T17:00:00Z", "live"))
    );
    // Three stale entries under an allowlisted project dir.
    for (const stale of ["a-gone.jsonl", "b-gone.jsonl", "c-gone.jsonl"]) {
      config.file_offsets[path.join(projectADir, stale)] = 100;
    }

    const watcher = makeWatcher(config, streamClient, { projectsDir: projectsRoot });
    const stats = await watcher.poll();

    expect(stats.offsetsPruned).toBe(3);
    expect(Object.keys(config.file_offsets)).toEqual([sessionFile]);
  });
});
