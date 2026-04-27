/**
 * Pure parsers: a markdown note's raw content + relative path → structured
 * fields the capture pipeline cares about (title, body, tags, frontmatter).
 *
 * Decisions for v0:
 *   - No YAML library. Frontmatter is captured as a raw string and the
 *     `tags:` field is parsed with a small regex (sufficient for the two
 *     formats Obsidian writes: inline list `tags: [a, b]` and block list
 *     `tags:\n  - a\n  - b`). Anything more exotic falls through to the
 *     inline-tag scanner, which is fine — we just over-tag, never under-tag.
 *   - Title precedence: first `# H1` line in the body, else filename
 *     without `.md`.
 *   - Tags are returned WITHOUT the leading `#` and de-duplicated.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)\b/g;
const H1_RE = /^# (.+)$/m;
const FRONTMATTER_TAGS_INLINE_RE = /^tags:\s*\[([^\]]*)\]\s*$/m;
const FRONTMATTER_TAGS_BLOCK_RE = /^tags:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/m;

export interface ParsedNote {
  /** First H1 line if present, else filename (without `.md`). Trimmed. */
  title: string;
  /** Note body with frontmatter removed (or the whole content if no frontmatter). */
  body: string;
  /** Raw frontmatter string (between `---` lines), or null if absent. */
  frontmatterRaw: string | null;
  /** De-duplicated tag names (no leading `#`). */
  tags: string[];
}

export function parseNote(rawContent: string, relPath: string): ParsedNote {
  const fmMatch = FRONTMATTER_RE.exec(rawContent);
  const frontmatterRaw = fmMatch ? fmMatch[1] : null;
  const body = fmMatch ? fmMatch[2] : rawContent;

  // Title: first H1 in body, else filename
  const h1 = H1_RE.exec(body);
  const fallbackTitle = relPath.split("/").pop()?.replace(/\.md$/i, "") ?? relPath;
  const title = (h1 ? h1[1] : fallbackTitle).trim() || fallbackTitle;

  // Tags: from frontmatter (both syntaxes) plus inline #tags in body
  const tags = new Set<string>();
  if (frontmatterRaw) {
    const inline = FRONTMATTER_TAGS_INLINE_RE.exec(frontmatterRaw);
    if (inline) {
      for (const raw of inline[1].split(",")) {
        const t = raw.trim().replace(/^#/, "").replace(/^["']|["']$/g, "");
        if (t.length > 0) tags.add(t);
      }
    }
    const block = FRONTMATTER_TAGS_BLOCK_RE.exec(frontmatterRaw);
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const m = /^\s+-\s+(.+?)\s*$/.exec(line);
        if (m) {
          const t = m[1].replace(/^#/, "").replace(/^["']|["']$/g, "");
          if (t.length > 0) tags.add(t);
        }
      }
    }
  }
  // Inline tags. Reset lastIndex because INLINE_TAG_RE has the /g flag.
  INLINE_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TAG_RE.exec(body)) !== null) {
    tags.add(m[1]);
  }

  return {
    title,
    body,
    frontmatterRaw,
    tags: Array.from(tags),
  };
}

/**
 * Stable 12-hex-character content fingerprint used in the idempotency key.
 * Lazy-imports node:crypto so this module remains pure-JS testable.
 */
export async function contentFingerprint(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}
