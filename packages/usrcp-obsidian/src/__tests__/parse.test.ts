/**
 * Unit tests for parseNote + contentFingerprint.
 *
 * No Ledger / no fs — pure parser behavior.
 *
 * Coverage:
 *   - Title precedence: H1 wins over filename; filename fallback when no H1
 *   - Frontmatter detection + body separation
 *   - Frontmatter tags (inline `[a, b]` and block `- a\n  - b`)
 *   - Inline #tag extraction in body
 *   - Tag deduplication across frontmatter + body
 *   - contentFingerprint determinism + sensitivity
 */

import { describe, it, expect } from "vitest";
import { parseNote, contentFingerprint } from "../parse.js";

// ---------------------------------------------------------------------------
// Title precedence
// ---------------------------------------------------------------------------

describe("parseNote: title precedence", () => {
  it("uses the first H1 line as title when present", () => {
    const note = parseNote("# My Heading\n\nbody text", "folder/note.md");
    expect(note.title).toBe("My Heading");
  });

  it("falls back to filename (without .md) when no H1", () => {
    const note = parseNote("just body, no heading", "folder/2026-04-27 Daily.md");
    expect(note.title).toBe("2026-04-27 Daily");
  });

  it("uses H1 even when filename would also work", () => {
    const note = parseNote("# Real Title\n\nbody", "boring-filename.md");
    expect(note.title).toBe("Real Title");
  });

  it("ignores headings deeper than H1 for title", () => {
    const note = parseNote("## H2 only\n\n### H3\n\nbody", "fallback.md");
    expect(note.title).toBe("fallback");
  });

  it("uses first H1 when multiple H1s are present", () => {
    const note = parseNote("# First\n\n# Second\n\nbody", "x.md");
    expect(note.title).toBe("First");
  });

  it("trims whitespace from H1 title", () => {
    const note = parseNote("#    Spaced Out   \n\nbody", "x.md");
    expect(note.title).toBe("Spaced Out");
  });

  it("strips path components from filename fallback", () => {
    const note = parseNote("body", "deep/nested/folder/Note Name.md");
    expect(note.title).toBe("Note Name");
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseNote: frontmatter", () => {
  it("returns frontmatterRaw=null when there is no frontmatter", () => {
    const note = parseNote("# Title\n\nbody", "x.md");
    expect(note.frontmatterRaw).toBeNull();
    expect(note.body).toBe("# Title\n\nbody");
  });

  it("extracts frontmatter and strips it from body", () => {
    const raw = "---\ntitle: hi\nauthor: frank\n---\n# Heading\n\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.frontmatterRaw).toBe("title: hi\nauthor: frank");
    expect(note.body).toBe("# Heading\n\nbody");
  });

  it("handles CRLF line endings in frontmatter", () => {
    const raw = "---\r\ntitle: hi\r\n---\r\nbody after";
    const note = parseNote(raw, "x.md");
    expect(note.frontmatterRaw).toBe("title: hi");
    expect(note.body).toBe("body after");
  });

  it("title comes from H1 in body, not frontmatter title field", () => {
    // We don't parse frontmatter `title:` into title — H1 wins.
    const raw = "---\ntitle: Frontmatter Title\n---\n# Body H1\n\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.title).toBe("Body H1");
  });
});

// ---------------------------------------------------------------------------
// Tags: frontmatter inline syntax
// ---------------------------------------------------------------------------

describe("parseNote: frontmatter tags (inline)", () => {
  it("parses `tags: [a, b, c]`", () => {
    const raw = "---\ntags: [alpha, beta, gamma]\n---\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips quotes around tag values", () => {
    const raw = `---\ntags: ["quoted", 'single', plain]\n---\nbody`;
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["plain", "quoted", "single"]);
  });

  it("strips leading # in frontmatter tags", () => {
    const raw = "---\ntags: [#hashed, plain]\n---\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["hashed", "plain"]);
  });

  it("handles empty inline list `tags: []`", () => {
    const raw = "---\ntags: []\n---\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tags: frontmatter block syntax
// ---------------------------------------------------------------------------

describe("parseNote: frontmatter tags (block)", () => {
  it("parses `tags:\\n  - a\\n  - b` block list", () => {
    const raw = "---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips leading # in block list items", () => {
    const raw = "---\ntags:\n  - #hashed\n  - plain\n---\nbody";
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["hashed", "plain"]);
  });
});

// ---------------------------------------------------------------------------
// Tags: inline #tag mentions in body
// ---------------------------------------------------------------------------

describe("parseNote: inline #tags in body", () => {
  it("extracts #tag mentions from body", () => {
    const note = parseNote("# H\n\nThis is about #project and #ideas.", "x.md");
    expect(note.tags.sort()).toEqual(["ideas", "project"]);
  });

  it("supports nested tags like #parent/child", () => {
    const note = parseNote("# H\n\n#work/usrcp and #personal", "x.md");
    expect(note.tags.sort()).toEqual(["personal", "work/usrcp"]);
  });

  it("does not match # at start of line (markdown heading)", () => {
    // INLINE_TAG_RE requires whitespace OR start-of-string before # — but a
    // heading line starts at start-of-string for a single-line input. We
    // intentionally allow that case (rare for top-of-body) and this test
    // documents observed behavior: pure heading without preceding space at
    // start-of-string IS captured as a tag because of the (?:^|\s) prefix.
    // The H1 case is naturally covered by the heading regex too — but the
    // tag regex sees "# Heading" and can match "#Heading" only if no space
    // follows. So `# Heading` (with the conventional space) is NOT tagged.
    const note = parseNote("# Real Heading\n\nbody", "x.md");
    expect(note.tags).toEqual([]);
  });

  it("requires a letter as the first char (does not capture #123)", () => {
    const note = parseNote("# H\n\nissue #1234 referenced", "x.md");
    expect(note.tags).toEqual([]);
  });

  it("deduplicates repeated inline tags", () => {
    const note = parseNote("# H\n\n#alpha #alpha #alpha", "x.md");
    expect(note.tags).toEqual(["alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Tag merging: frontmatter + inline + dedup
// ---------------------------------------------------------------------------

describe("parseNote: tag merging", () => {
  it("merges frontmatter and inline tags, deduplicating", () => {
    const raw =
      "---\ntags: [alpha, beta]\n---\n" +
      "# H\n\nMore on #beta and a new #gamma.";
    const note = parseNote(raw, "x.md");
    expect(note.tags.sort()).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// contentFingerprint
// ---------------------------------------------------------------------------

describe("contentFingerprint", () => {
  it("returns a 12-hex-char string", async () => {
    const fp = await contentFingerprint("hello world");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic — same input → same output", async () => {
    const a = await contentFingerprint("identical content");
    const b = await contentFingerprint("identical content");
    expect(a).toBe(b);
  });

  it("changes when content changes (single char edit)", async () => {
    const a = await contentFingerprint("the quick brown fox");
    const b = await contentFingerprint("the quick brown box");
    expect(a).not.toBe(b);
  });

  it("treats empty string as a valid input", async () => {
    const fp = await contentFingerprint("");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });
});
