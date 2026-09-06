import { buildHandoff, renderHandoff } from "../../handoff.js";
/**
 * CONTEXT.md generator — reads recent ledger events and writes a markdown
 * summary to ~/.usrcp/users/<profile>/CONTEXT.md.
 *
 * Called by `usrcp adapter terminal refresh-context`. Designed to be
 * safe to run frequently (e.g., every 15 minutes via cron). The cron
 * entry itself is NOT installed here — the setup wizard does that.
 *
 * The resulting CONTEXT.md gives Aider (and any other tool that reads it)
 * a warm-start context summary of recent USRCP activity without requiring
 * an MCP tool call.
 */

import { promises as fs } from "node:fs";
import { homeDir } from "./shared.js";
import { join } from "node:path";
import { Ledger } from "usrcp-core/ledger";
import {
  getUserDir,
  getUserSlug,
  safeWriteFile,
  migrateLegacyLayout,
  listUserSlugs,
  setUserSlug,
} from "usrcp-core/encryption";

export function contextMdPath(): string {
  homeDir();
  return join(getUserDir(), "CONTEXT.md");
}

export async function refreshContextMd(opts: {
  lastN?: number;
  passphrase?: string;
  userSlug?: string;
  domains?: string[];
} = {}): Promise<string> {
  migrateLegacyLayout();

  const slugs = listUserSlugs();
  const slug = opts.userSlug ?? (slugs.length === 1 ? slugs[0] : getUserSlug());
  setUserSlug(slug);

  const passphrase = opts.passphrase;
  const ledger = new Ledger(undefined, passphrase);
  let content: string;
  try {
    const domains = opts.domains ?? ledger.getStats().domains;
    const sections = domains.slice(0, 8).map((domain) => renderHandoff(buildHandoff(ledger, domain, Math.max(1000, Math.floor(6000 / Math.max(domains.length, 1))))));
    content = `<!-- USRCP profile: ${slug}. Condensed plaintext export. -->\n` + sections.join("\n");
  } finally { ledger.close(); }
  await fs.mkdir(getUserDir(), { recursive: true, mode: 0o700 });
  const output = contextMdPath();
  safeWriteFile(output, Buffer.from(content, "utf8"), 0o600);
  return output;
}
