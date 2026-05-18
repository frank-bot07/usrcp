/**
 * Adapter registry.
 *
 * Replaces the three parallel hardcoded lists in #54-60:
 *   - `KNOWN_ADAPTERS`         (setup.ts) - wizard catalog
 *   - `ADAPTERS_REQUIRING_MASTER_KEY` (setup.ts) - standalone --adapter master-key gate
 *   - `ADAPTERS_WITH_ENCRYPTED_CONFIG` (rotate-adapter-configs.ts) - rotate-key participation
 *
 * All three are now derived from one `AdapterManifest[]` source of truth:
 * a hardcoded BUILTIN_ADAPTERS array for in-tree packages, plus an
 * optional `~/.usrcp/adapters.json` registry for external packages.
 *
 * Per [[project_usrcp_adapters_as_addons]] this is the first half of
 * the marketplace pivot - third-party adapters can self-register
 * once they're npm-installed by adding an entry to the JSON file.
 * The contract (AdapterManifest fields below) is the boundary;
 * everything inside the boundary is interchangeable.
 *
 * v1 scope: schema + loader + derived helpers. Out of scope:
 * `usrcp adapter add <package>` CLI helper (operator hand-edits the
 * JSON for now); adapter-version negotiation; auto-discovery via
 * npm package-name scan.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Public contract for adapters. Each in-tree adapter has an entry in
 * `BUILTIN_ADAPTERS`; external adapters declare the same shape in
 * `~/.usrcp/adapters.json` (the schema-on-disk form is `{ adapters:
 * AdapterManifest[] }`).
 */
export interface AdapterManifest {
  /**
   * Stable identifier. Used in `--adapter=<value>`, in config file
   * names (`~/.usrcp/<value>-config.json`), and as the cursor key in
   * the rotate-adapter-configs dispatcher. Must match the npm package
   * suffix for in-tree adapters: `usrcp-<value>`.
   */
  value: string;
  /** Human-readable name shown in the interactive wizard. */
  name: string;
  /** One-paragraph description shown next to the wizard prompt. */
  blurb: string;
  /**
   * Name of the exported setup function in the adapter's dist/setup.js.
   * The setup dispatcher in setup.ts looks this up by name and calls
   * it with `{ masterKey }` when the adapter declares
   * `requiresMasterKey: true`. Required for non-special-cased adapters
   * (terminal / mcp-agent / openclaw bypass this).
   */
  setupFunction?: string;
  /**
   * When true, the standalone `usrcp setup --adapter=<value>` path
   * acquires the master key from the ledger before invoking the
   * setup wizard. Adapters that encrypt secrets at rest must set
   * this to true.
   */
  requiresMasterKey?: boolean;
  /**
   * When true, the rotate-key hook calls
   * `reencryptConfigUnderNewKey(oldKey, newKey)` from the adapter's
   * dist/config.js during master-key rotation. Adapters that encrypt
   * secrets at rest must set this to true so a rotate doesn't
   * silently invalidate their on-disk credentials.
   */
  supportsRotateKey?: boolean;
  /**
   * npm package name that exports the setup module. Default
   * `"usrcp-<value>"` for in-tree adapters. External adapters
   * override this (e.g. `"usrcp-adapter-notion"`).
   */
  packageName?: string;
  /** Hide from the interactive wizard. Still selectable via `--adapter=<value>`. */
  hidden?: boolean;
  /** Only show on Darwin hosts. */
  requiresMacOS?: boolean;
  /**
   * Marks adapters that live inside `usrcp-local` rather than as a
   * sibling package. The standard dispatcher dynamic-imports
   * `<packageName>/dist/setup.js`, but builtin-internal adapters
   * (terminal, mcp-agent, openclaw) have their setup wired inline
   * in setup.ts:callAdapterSetup. External adapters MUST NOT set
   * this flag - it's specifically for the trio that pre-date the
   * sibling-package convention.
   */
  builtinInternal?: boolean;
}

/**
 * Source-of-truth list for in-tree adapters. Adding a new adapter
 * means (a) creating `packages/usrcp-<value>/`, (b) appending an
 * entry here. The previous parallel-list mistakes
 * (#54, #55, #56 each had to remember three list updates) are
 * impossible by construction now.
 */
export const BUILTIN_ADAPTERS: readonly AdapterManifest[] = [
  // --- Builtin-internal (live inside usrcp-local) ---------------------
  {
    value: "terminal",
    name: "Terminal / CLI agents (Claude Code, Cursor, Codex, etc.)",
    blurb: "RECOMMENDED. Wires USRCP into your MCP-aware CLI agents (Claude Code, Cursor, Codex, Copilot CLI, Cline, Continue, Aider) so every terminal session has cross-platform memory. No external accounts or bot tokens required.",
    builtinInternal: true,
  },
  {
    value: "openclaw",
    name: "OpenClaw (agent harness)",
    blurb: "Requires OpenClaw already installed (https://docs.openclaw.ai/start/getting-started). Registers USRCP as an MCP server in your OpenClaw config so OpenClaw agents can read/write your ledger via the same 6 tools as Claude Code. Read-side only in v0 - capture per channel still goes through the dedicated Discord/Slack/iMessage adapters.",
    builtinInternal: true,
  },
  {
    value: "mcp-agent",
    name: "Scoped MCP agent (per-process restriction)",
    blurb: "Generate an MCP config snippet that runs `usrcp serve` with --scopes / --readonly / --no-audit so one agent (e.g. Cursor) can only see a subset of your domains. Use this in addition to (not instead of) the terminal adapter. Run via `usrcp setup --adapter=mcp-agent`.",
    builtinInternal: true,
    hidden: true,
  },

  // --- Chat adapters (encrypted bot tokens) ----------------------------
  {
    value: "discord",
    name: "Discord",
    blurb: "Free. Requires a Discord account, a server you control, and an Anthropic API key.",
    setupFunction: "runDiscordSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "telegram",
    name: "Telegram",
    blurb: "Free. Requires a Telegram account and an Anthropic API key. Mobile-friendly setup via BotFather.",
    setupFunction: "runTelegramSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "slack",
    name: "Slack",
    blurb: "⚠️  Requires a PAID Slack workspace tier (Pro, Business+, or Enterprise) - bot APIs are restricted on the free tier. Skip this if your workspace is on the free plan.",
    setupFunction: "runSlackSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "imessage",
    name: "iMessage (macOS)",
    blurb: "macOS only. Requires Full Disk Access for Messages.app + the imsg CLI (brew install steipete/tap/imsg).",
    setupFunction: "runImessageSetup",
    requiresMacOS: true,
    // No master-key fields: iMessage has no LLM key today (read-only via chat.db).
  },

  // --- Polling adapters (encrypted OAuth/PAT tokens) -------------------
  {
    value: "obsidian",
    name: "Obsidian (local vault)",
    blurb: "Capture notes from a local Obsidian vault. Watches the vault directory and appends each note edit to the ledger. v0: capture-only, no replies.",
    setupFunction: "runObsidianSetup",
  },
  {
    value: "linear",
    name: "Linear",
    blurb: "Capture issues and comments YOU author in Linear. Polls Linear's GraphQL API every minute (configurable). Requires a Linear personal API key. v0: capture-only, no @usrcp replies.",
    setupFunction: "runLinearSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "google-calendar",
    name: "Google Calendar",
    blurb: "Capture past events you attended on your primary Google Calendar. Polls every 5 min (configurable). Requires a Google Cloud OAuth client + refresh token (see packages/usrcp-google-calendar/README.md). v0: capture-only.",
    setupFunction: "runGoogleCalendarSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "gmail",
    name: "Gmail",
    blurb: "Capture messages YOU sent in Gmail. Polls every 10 min (configurable). Requires a Google Cloud OAuth client + refresh token (same setup as Google Calendar, different scope). v0: capture-only, no received mail.",
    setupFunction: "runGmailSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },
  {
    value: "github",
    name: "GitHub",
    blurb: "Capture pull requests YOU author on GitHub. Polls GitHub's REST search API every 10 min (configurable). Requires a personal access token. v1: capture-only on pr_opened (state changes come later).",
    setupFunction: "runGithubSetup",
    requiresMasterKey: true,
    supportsRotateKey: true,
  },

  // --- UI extensions ---------------------------------------------------
  {
    value: "extension",
    name: "Browser extension (Chrome)",
    blurb: "Capture claude.ai conversations and inject ledger context via /usrcp slash command. Chrome only in v0; requires manual extension load (Developer Mode → Load Unpacked).",
    setupFunction: "runExtensionSetup",
  },
];

const EXTERNAL_REGISTRY_FILENAME = "adapters.json";

interface ExternalRegistryFile {
  adapters?: AdapterManifest[];
}

/**
 * Path to the external-adapters registry file. Operators hand-edit
 * this until we ship `usrcp adapter add`. The file lives in
 * `~/.usrcp/` alongside the per-adapter config files so it's
 * visible to the same backup/snapshot story.
 */
export function getExternalRegistryPath(): string {
  return path.join(os.homedir(), ".usrcp", EXTERNAL_REGISTRY_FILENAME);
}

/**
 * Read external adapter manifests from `~/.usrcp/adapters.json`.
 * Returns an empty array when the file is missing, malformed, or
 * unreadable - never throws. A bad registry file must not block
 * `usrcp setup` from running for the builtin adapters.
 */
export function loadExternalAdapters(
  registryPath: string = getExternalRegistryPath(),
): AdapterManifest[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  let parsed: ExternalRegistryFile;
  try {
    parsed = JSON.parse(raw) as ExternalRegistryFile;
  } catch (err) {
    console.error(
      `[usrcp] Warning: external adapter registry at ${registryPath} is not valid JSON; ignoring. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
  if (!parsed || !Array.isArray(parsed.adapters)) return [];

  // Sanity-check each entry. External manifests are user-provided
  // input, so reject anything missing the minimum required fields
  // OR with a malformed optional field rather than letting it crash
  // the dispatcher later. Codex round-1 review on PR #62 caught the
  // optional-field case: `packageName: true` previously passed the
  // loader and then crashed `path.join(...)` at dispatch time. The
  // loader is the trust boundary; everything past it assumes types.
  const out: AdapterManifest[] = [];
  for (const m of parsed.adapters) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.value !== "string" || m.value.length === 0) continue;
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    if (typeof m.blurb !== "string") continue;
    if (m.builtinInternal) {
      // External adapters must not claim builtin-internal status -
      // the dispatcher has inline wiring for the three names that
      // are allowed to use it.
      console.error(
        `[usrcp] Warning: external adapter "${m.value}" sets builtinInternal=true; this is reserved for in-tree adapters. Ignoring entry.`,
      );
      continue;
    }

    // Optional fields: only reject if the field is present AND has
    // the wrong type. Missing fields are fine (defaults apply
    // downstream). A bad type here would propagate to path.join
    // (packageName), `mod[fnName]` (setupFunction), or the
    // platform/hidden boolean checks.
    const badField = (
      label: string,
      val: unknown,
      expected: "string" | "boolean",
    ): boolean => {
      if (val === undefined) return false;
      if (typeof val === expected) return false;
      console.error(
        `[usrcp] Warning: external adapter "${m.value}" has ${label}=${JSON.stringify(val)} ` +
          `(expected ${expected}); ignoring entry.`,
      );
      return true;
    };
    if (badField("setupFunction", m.setupFunction, "string")) continue;
    if (badField("packageName", m.packageName, "string")) continue;
    if (badField("requiresMasterKey", m.requiresMasterKey, "boolean")) continue;
    if (badField("supportsRotateKey", m.supportsRotateKey, "boolean")) continue;
    if (badField("hidden", m.hidden, "boolean")) continue;
    if (badField("requiresMacOS", m.requiresMacOS, "boolean")) continue;

    // Also reject empty-string optional strings - they'd pass the
    // typeof check but lead to broken require.resolve("/dist/setup.js")
    // or `mod[""]` lookups.
    if (m.setupFunction !== undefined && (m.setupFunction as string).length === 0) {
      console.error(
        `[usrcp] Warning: external adapter "${m.value}" has setupFunction=""; ignoring entry.`,
      );
      continue;
    }
    if (m.packageName !== undefined && (m.packageName as string).length === 0) {
      console.error(
        `[usrcp] Warning: external adapter "${m.value}" has packageName=""; ignoring entry.`,
      );
      continue;
    }

    out.push(m);
  }
  return out;
}

/**
 * Return the unified list of adapters available on this install:
 * built-in (in-tree) first, external (from `~/.usrcp/adapters.json`)
 * appended. Duplicate `value`s are deduped with built-ins winning.
 *
 * The function is pure: it re-reads the JSON file each call so
 * operators can edit it without restarting the daemon. (Adapter
 * registration is rare; the cost of one disk read per call is
 * negligible.)
 */
export function getRegisteredAdapters(opts?: {
  externalRegistryPath?: string;
  /** For tests: skip the disk read. */
  skipExternal?: boolean;
}): AdapterManifest[] {
  const builtin = BUILTIN_ADAPTERS as AdapterManifest[];
  if (opts?.skipExternal) return [...builtin];
  const external = loadExternalAdapters(opts?.externalRegistryPath);
  const seen = new Set(builtin.map((m) => m.value));
  const merged: AdapterManifest[] = [...builtin];
  for (const m of external) {
    if (seen.has(m.value)) {
      console.error(
        `[usrcp] Warning: external adapter "${m.value}" shadows a built-in with the same value; using built-in.`,
      );
      continue;
    }
    seen.add(m.value);
    merged.push(m);
  }
  return merged;
}

/** Find a manifest by `value`, or undefined. */
export function findAdapter(
  value: string,
  adapters: AdapterManifest[] = getRegisteredAdapters(),
): AdapterManifest | undefined {
  return adapters.find((a) => a.value === value);
}

/**
 * Adapter `value`s whose wizards encrypt config secrets at rest -
 * derived from manifest.requiresMasterKey. Replaces the hardcoded
 * `ADAPTERS_REQUIRING_MASTER_KEY` set that previously lived in
 * setup.ts and drifted whenever a new encrypting adapter was added
 * (#54, #55 each had to remember the second list).
 */
export function getMasterKeyRequiringAdapterValues(
  adapters: AdapterManifest[] = getRegisteredAdapters(),
): Set<string> {
  return new Set(
    adapters.filter((a) => a.requiresMasterKey === true).map((a) => a.value),
  );
}

/**
 * Adapter `value`s that participate in the rotate-key hook -
 * derived from manifest.supportsRotateKey. Replaces the hardcoded
 * `ADAPTERS_WITH_ENCRYPTED_CONFIG` list in rotate-adapter-configs.ts
 * that previously had to be hand-synced with the encrypting set.
 */
export function getRotateKeyAdapterValues(
  adapters: AdapterManifest[] = getRegisteredAdapters(),
): string[] {
  return adapters.filter((a) => a.supportsRotateKey === true).map((a) => a.value);
}

/**
 * Resolve the npm package name for an adapter's dist/setup.js.
 * Builtin-internal adapters return null (they're wired inline in
 * setup.ts). The default `usrcp-<value>` covers all sibling-package
 * adapters; manifests can override via `packageName` (the marketplace
 * extension point - an external `usrcp-adapter-notion` package can
 * register as `value: "notion"` with `packageName: "usrcp-adapter-notion"`).
 */
export function resolveAdapterPackageName(manifest: AdapterManifest): string | null {
  if (manifest.builtinInternal) return null;
  return manifest.packageName ?? `usrcp-${manifest.value}`;
}
