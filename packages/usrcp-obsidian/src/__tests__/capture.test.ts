/**
 * Integration tests for the Obsidian capture pipeline.
 *
 * Verified:
 *   - Filter chain: excluded_subdirs / allowed_subdirs / excluded_tags /
 *     allowed_tags / empty_body
 *   - Happy path: events written with channel_id = relative path,
 *     summary = title, intent = "note_capture"
 *   - Idempotency: same content produces a duplicate marker, edited content
 *     produces a new event
 *   - Ciphertext at rest: raw SQLite inspection confirms plaintext is not
 *     stored in any column
 *   - Restart persistence: events survive close + re-open
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureNote } from "../capture.js";
import { parseNote } from "../parse.js";
import type { ObsidianConfig } from "../config.js";

const baseConfig: ObsidianConfig = {
  vault_path: "/dev/null/vault",
  domain: "obsidian",
  debounce_ms: 1500,
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-obsidian-capture-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  dbPath = path.join(tmpHome, "ledger.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function capture(
  rawContent: string,
  relPath: string,
  config: ObsidianConfig = baseConfig,
) {
  const note = parseNote(rawContent, relPath);
  return captureNote(ledger, note, relPath, rawContent, config);
}

// ---------------------------------------------------------------------------
// Filter: excluded_subdirs
// ---------------------------------------------------------------------------

describe("filter: excluded_subdir", () => {
  it("skips notes under an excluded subdirectory", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, excluded_subdirs: ["private"] };
    const result = await capture("# Secret\n\nstuff", "private/secret.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("excluded_subdir");
  });

  it("skips notes nested deep under an excluded subdirectory", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, excluded_subdirs: ["private"] };
    const result = await capture("# x\n\nbody", "private/sub/sub/note.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("excluded_subdir");
  });

  it("does NOT skip notes whose path merely contains the excluded segment as a substring", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, excluded_subdirs: ["work"] };
    // "workshop" is not under "work/"
    const result = await capture("# x\n\nbody", "workshop/note.md", cfg);
    expect(result.captured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filter: allowed_subdirs
// ---------------------------------------------------------------------------

describe("filter: subdir_not_allowlisted", () => {
  it("captures notes under an allowlisted subdirectory", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, allowed_subdirs: ["journal"] };
    const result = await capture("# x\n\nbody", "journal/2026-04-27.md", cfg);
    expect(result.captured).toBe(true);
  });

  it("skips notes outside the allowlist when allowlist is set", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, allowed_subdirs: ["journal"] };
    const result = await capture("# x\n\nbody", "scratch/idea.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("subdir_not_allowlisted");
  });

  it("empty allowlist is treated as no allowlist (captures everything)", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, allowed_subdirs: [] };
    const result = await capture("# x\n\nbody", "anywhere/note.md", cfg);
    expect(result.captured).toBe(true);
  });

  it("excluded_subdirs takes precedence over allowed_subdirs", async () => {
    const cfg: ObsidianConfig = {
      ...baseConfig,
      allowed_subdirs: ["work"],
      excluded_subdirs: ["work/private"],
    };
    const result = await capture("# x\n\nbody", "work/private/secret.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("excluded_subdir");
  });
});

// ---------------------------------------------------------------------------
// Filter: tag-based filtering
// ---------------------------------------------------------------------------

describe("filter: excluded_tag", () => {
  it("skips notes that have any excluded tag", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, excluded_tags: ["private"] };
    const result = await capture("# x\n\nbody #private here", "n.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("excluded_tag");
  });

  it("strips leading # from excluded_tags entries", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, excluded_tags: ["#private"] };
    const result = await capture("# x\n\nbody #private here", "n.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("excluded_tag");
  });
});

describe("filter: no_allowlisted_tag", () => {
  it("captures notes that have at least one allowlisted tag", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, allowed_tags: ["work"] };
    const result = await capture("# x\n\nbody #work content", "n.md", cfg);
    expect(result.captured).toBe(true);
  });

  it("skips notes that match no allowlisted tag", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, allowed_tags: ["work"] };
    const result = await capture("# x\n\nno relevant tags here", "n.md", cfg);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_allowlisted_tag");
  });
});

// ---------------------------------------------------------------------------
// Filter: empty body
// ---------------------------------------------------------------------------

describe("filter: empty_body", () => {
  it("skips notes whose body is whitespace only", async () => {
    const result = await capture("   \n\n  \n", "blank.md");
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_body");
  });

  it("skips notes with frontmatter only and no body", async () => {
    const raw = "---\ntitle: empty\n---\n";
    const result = await capture(raw, "fm-only.md");
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_body");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("capture: happy path", () => {
  it("captures with channel_id = relative path and summary = title", async () => {
    const result = await capture("# Hello World\n\nThis is a note.", "folder/hello.md");
    expect(result.captured).toBe(true);

    const events = ledger.getTimeline({ last_n: 10 });
    expect(events.length).toBe(1);
    expect(events[0].channel_id).toBe("folder/hello.md");
    expect(events[0].summary).toBe("Hello World");
    expect(events[0].intent).toBe("note_capture");
    expect(events[0].outcome).toBe("success");
  });

  it("falls back to filename as summary when no H1 present", async () => {
    const result = await capture("just body content", "Daily 2026-04-27.md");
    expect(result.captured).toBe(true);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].summary).toBe("Daily 2026-04-27");
  });

  it("includes the body and frontmatter in detail", async () => {
    const raw = "---\nauthor: frank\n---\n# H\n\nbody text";
    await capture(raw, "n.md");
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].detail).toMatchObject({
      relative_path: "n.md",
      title: "H",
      body: "# H\n\nbody text",
      frontmatter: "author: frank",
    });
  });

  it("attaches obsidian + note tags plus a sample of note tags", async () => {
    const result = await capture("# H\n\n#alpha #beta #gamma", "n.md");
    expect(result.captured).toBe(true);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].tags).toContain("obsidian");
    expect(events[0].tags).toContain("note");
    // At least one of the inline tags should be present.
    expect(events[0].tags!.some((t) => ["alpha", "beta", "gamma"].includes(t))).toBe(true);
  });

  it("uses the configured domain", async () => {
    const cfg: ObsidianConfig = { ...baseConfig, domain: "personal-notes" };
    await capture("# H\n\nbody", "n.md", cfg);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].domain).toBe("personal-notes");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("re-saving the same content is marked duplicate (one timeline row)", async () => {
    const raw = "# Same\n\nidentical body";
    const first = await capture(raw, "same.md");
    expect(first.captured).toBe(true);
    if (!first.captured) throw new Error("unreachable");
    expect(first.duplicate).toBe(false);

    const second = await capture(raw, "same.md");
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    expect(second.event_id).toBe(first.event_id);

    const events = ledger.getTimeline({ last_n: 100 });
    expect(events.length).toBe(1);
  });

  it("editing the content produces a NEW event (not a duplicate)", async () => {
    const first = await capture("# x\n\nfirst version", "n.md");
    expect(first.captured).toBe(true);
    if (!first.captured) throw new Error("unreachable");

    const second = await capture("# x\n\nsecond version (edited)", "n.md");
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(false);
    expect(second.event_id).not.toBe(first.event_id);

    const events = ledger.getTimeline({ last_n: 100 });
    expect(events.length).toBe(2);
  });

  it("same content under different relative paths is NOT a duplicate", async () => {
    const raw = "# H\n\nshared body";
    const a = await capture(raw, "folder-a/note.md");
    const b = await capture(raw, "folder-b/note.md");
    expect(a.captured).toBe(true);
    expect(b.captured).toBe(true);
    if (!a.captured || !b.captured) throw new Error("unreachable");
    expect(b.duplicate).toBe(false);
    expect(a.event_id).not.toBe(b.event_id);
  });
});

// ---------------------------------------------------------------------------
// Ciphertext at rest
// ---------------------------------------------------------------------------

describe("ciphertext at rest", () => {
  it("channel_id, summary, detail, tags are all encrypted", async () => {
    const markers = {
      relPath: "private-DISTINCTMARKER-TURQUOISE/note.md",
      title: "TitleMarkerVERMILION",
      body: "body-marker-ELEPHANT-distinctive-plaintext",
      tag: "uniquetagMARIGOLD",
    };
    const raw = `# ${markers.title}\n\n${markers.body} #${markers.tag}`;
    const result = await capture(raw, markers.relPath);
    expect(result.captured).toBe(true);

    const raw_db = new Database(dbPath, { readonly: true });
    const row = raw_db
      .prepare(
        `SELECT channel_id, external_user_id, summary, detail, tags, channel_hash
         FROM timeline_events`
      )
      .get() as Record<string, string | null>;
    raw_db.close();

    // Encrypted columns must start with "enc:" (or be NULL — single-user
    // adapter omits external_user_id).
    expect((row["channel_id"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["summary"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["detail"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["tags"] ?? "").startsWith("enc:")).toBe(true);

    // Plaintext markers must not appear in any ciphertext.
    for (const col of ["channel_id", "summary", "detail", "tags"]) {
      const val = row[col];
      if (val === null) continue;
      expect(val).not.toContain(markers.relPath);
      expect(val).not.toContain(markers.title);
      expect(val).not.toContain(markers.body);
      expect(val).not.toContain(markers.tag);
    }

    // channel_hash is deterministic HMAC — hex, not the plaintext path.
    expect(row["channel_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["channel_hash"]).not.toBe(markers.relPath);
  });

  it("decrypted channel_id round-trips through Ledger read", async () => {
    await capture("# H\n\nbody", "deep/folder/note.md");
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].channel_id).toBe("deep/folder/note.md");
    expect(events[0].summary).toBe("H");
  });
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

describe("restart persistence", () => {
  it("events survive ledger close + re-open", async () => {
    const result = await capture("# Persist\n\nObsidian persistence check", "p.md");
    expect(result.captured).toBe(true);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const events = reopened.getTimeline({ last_n: 10 });
      expect(events.length).toBe(1);
      expect(events[0].channel_id).toBe("p.md");
      expect(events[0].summary).toBe("Persist");

      const byChannel = reopened.getRecentEventsByChannel("p.md", 10);
      expect(byChannel.length).toBe(1);
    } finally {
      reopened.close();
      ledger = new Ledger(dbPath); // so afterEach close() doesn't double-close
    }
  });
});
