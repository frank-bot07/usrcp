import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ledger } from "./ledger/index.js";
import { getIdentity } from "./crypto.js";
import { VersionConflictError } from "./types.js";
import type { CoreIdentity, GlobalPreferences } from "./types.js";
import {
  reencryptAdapterConfigs,
  type AdapterReencryptResult,
} from "./rotate-adapter-configs.js";

// --- Security constants ---
const MAX_STRING_SHORT = 100; // identifiers, domains, keys
const MAX_STRING_MEDIUM = 300; // intents, names, summaries
const MAX_STRING_LONG = 500; // summaries, descriptions
const MAX_STRING_URI = 2048; // URIs and refs
const MAX_ARRAY_ITEMS = 50; // tags, artifacts, expertise
const MAX_RECORD_KEYS = 50; // detail blobs, custom prefs, domain context
const MAX_SEARCH_QUERY = 200; // search input

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/**
 * Per-process scope enforcement (Model A). Each `usrcp serve` invocation can
 * be scoped to a domain allowlist + tool allowlist, with every call audit-
 * tagged with the agent_id. Default (all fields undefined) preserves
 * current behavior — full access, all tools, no agent identification.
 *
 * Threat model: cross-agent isolation in personal-use single-user mode. The
 * user controls what each agent sees at the MCP config layer (no hidden
 * tokens). Not a substitute for cryptographic capability tokens (Model B).
 */
export interface ServeOptions {
  /**
   * Legacy symmetric domain allowlist. Sets BOTH `readScopes` and
   * `writeScopes` to the same value. Empty array is treated as
   * unrestricted. Mutually exclusive with `readScopes` / `writeScopes`
   * (caller must not mix them).
   */
  scopes?: string[];
  /**
   * Domains the agent is allowed to READ from. Undefined = unrestricted.
   * Empty array is normalized to undefined (unrestricted reads).
   *
   * When set alone (without `writeScopes` or legacy `scopes`),
   * defaults `writeScopes` to `[]` (no writes anywhere). This means
   * `--read-scopes X` on its own is a "read-only on X" shorthand.
   */
  readScopes?: string[];
  /**
   * Domains the agent is allowed to WRITE to. Undefined = unrestricted.
   * Empty array (`[]`) means "no writes anywhere" - equivalent to
   * `readonly: true`. When both `readScopes` and `writeScopes` are
   * set as non-empty allowlists, `writeScopes` must be a subset of
   * `readScopes` (writes require reads on the same domain).
   */
  writeScopes?: string[];
  /**
   * Strip mutating tools from the registered tool list. Equivalent
   * to `writeScopes: []`. If both are set, this still wins.
   */
  readonly?: boolean;
  /** Hide the audit-log tool so agents can't read other agents' history. */
  noAudit?: boolean;
  /** Identifier logged with every tool call. Required when any scope flag is set. */
  agentId?: string;
}

// ----------------------------------------------------------------------------
// Internal types — tool registry
// ----------------------------------------------------------------------------

/**
 * Each tool is one of these kinds, which determines how scope enforcement
 * applies in `registerAll`.
 *   global-read       — always allowed regardless of scopes (e.g. status)
 *   global-mutation   — refused outright when scopes is set (rotate_key,
 *                       update_identity, update_preferences). These touch
 *                       state shared across every domain.
 *   audit-read        — readonly but suppressed by --no-audit
 *   domain-scoped     — operates on a single (or finite) set of domains;
 *                       scopeOf(params) must be a subset of opts.scopes
 *   multi-domain-read — reads across many domains; handler is responsible
 *                       for filtering its own output to opts.scopes (the
 *                       wrapper still rejects explicit out-of-scope filters)
 */
type ToolKind =
  | "global-read"
  | "global-mutation"
  | "audit-read"
  | "domain-scoped"
  | "multi-domain-read";

interface ToolDef {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  handler: (params: any) => Promise<any>;
  mutating: boolean;
  kind: ToolKind;
  /**
   * Returns the domain(s) the call would touch. For multi-domain-read, may
   * return the literal "all" if the call is unconstrained — in which case
   * the handler itself must filter its results to opts.scopes.
   */
  scopeOf?: (params: any) => string[] | "all";
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function formatUserId(rawId: string | undefined): string {
  return `usrcp://local/${rawId || "anonymous"}`;
}

function versionConflictResponse(err: VersionConflictError) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "version_conflict",
            error: "VERSION_CONFLICT",
            scope: err.scope,
            target: err.target,
            current_version: err.currentVersion,
            expected_version: err.expectedVersion,
            message: err.message,
          },
          null,
          2
        ),
      },
    ],
  };
}

function outOfScopeResponse(toolName: string, requested: string[], allowed: string[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "out_of_scope",
            error: "OUT_OF_SCOPE",
            tool: toolName,
            requested_domains: requested,
            allowed_domains: allowed,
            message:
              `Tool '${toolName}' was called with out-of-scope target(s): [${requested.join(", ")}]. ` +
              `This MCP server is scoped to: [${allowed.join(", ")}]. ` +
              `Re-launch usrcp serve with broader --scopes or call this tool from an unscoped server.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

function boundedRecord() {
  return z
    .record(z.string().max(MAX_STRING_SHORT), z.unknown())
    .refine((obj) => Object.keys(obj).length <= MAX_RECORD_KEYS, {
      message: `Record must have at most ${MAX_RECORD_KEYS} keys`,
    });
}

export interface ResolvedScopes {
  /** undefined = unrestricted reads; otherwise an allowlist of domain names. */
  readScopes: string[] | undefined;
  /**
   * undefined = unrestricted writes; non-empty array = write allowlist;
   * empty array = no writes anywhere (strips mutating tools at register time).
   */
  writeScopes: string[] | undefined;
}

/**
 * Resolve the four scope-related ServeOptions into the two effective
 * arrays used by registerAll. The legacy `--scopes` flag is an alias
 * for "both readScopes and writeScopes equal to scopes"; the new
 * `readScopes` / `writeScopes` flags can be combined for asymmetric
 * permissions.
 *
 * Throws when the inputs are mutually inconsistent (e.g. writeScopes
 * has a domain that's not in readScopes).
 */
export function resolveScopes(opts: ServeOptions): ResolvedScopes {
  // Mutex: --scopes is a symmetric shorthand. Mixing it with the new
  // asymmetric flags is ambiguous; reject early so the operator sees
  // the conflict rather than silently picking one.
  if (
    opts.scopes !== undefined &&
    (opts.readScopes !== undefined || opts.writeScopes !== undefined)
  ) {
    throw new Error(
      "--scopes is mutually exclusive with --read-scopes / --write-scopes. " +
        "Use --scopes alone (symmetric) OR the asymmetric pair.",
    );
  }

  let readScopes: string[] | undefined = opts.readScopes;
  let writeScopes: string[] | undefined = opts.writeScopes;

  // Legacy --scopes: set both to the same value.
  if (opts.scopes !== undefined) {
    readScopes = opts.scopes;
    writeScopes = opts.scopes;
  }

  // Asymmetric default: --read-scopes alone means "no writes". Without
  // this, --read-scopes X would silently allow writes to all domains -
  // surprising and the opposite of the operator's likely intent.
  if (
    opts.readScopes !== undefined &&
    opts.writeScopes === undefined &&
    opts.scopes === undefined
  ) {
    writeScopes = [];
  }

  // --readonly wins: strip all writes regardless of writeScopes.
  if (opts.readonly === true) {
    writeScopes = [];
  }

  // Empty-array normalization for reads: treat `--read-scopes=` /
  // `--scopes=` as "unrestricted" so the operator doesn't lock
  // themselves out by passing an empty CSV. Writes use [] as the
  // sentinel for "no writes", so we do NOT normalize writes here.
  if (readScopes !== undefined && readScopes.length === 0) {
    readScopes = undefined;
  }

  // writeScopes ⊆ readScopes when both are restrictive. Empty
  // writeScopes (`[]`, the "no writes" sentinel) is trivially a
  // subset, so skip the check in that case.
  if (
    writeScopes !== undefined &&
    writeScopes.length > 0 &&
    readScopes !== undefined
  ) {
    const outOfRead = writeScopes.filter((d) => !readScopes!.includes(d));
    if (outOfRead.length > 0) {
      throw new Error(
        `writeScopes contains domains not in readScopes: [${outOfRead.join(", ")}]. ` +
          "Writes require read access on the same domain.",
      );
    }
  }

  return { readScopes, writeScopes };
}

// ----------------------------------------------------------------------------
// createServer
// ----------------------------------------------------------------------------

export function createServer(
  passphrase?: string,
  opts: ServeOptions = {}
): { server: McpServer; shutdown: () => void; ledger: Ledger } {
  const ledger = new Ledger(undefined, passphrase);
  const identity = getIdentity();

  const shutdown = () => {
    ledger.close();
  };

  const server = new McpServer({
    name: "usrcp-local",
    version: "0.1.0",
  });

  // Resolve once and share across registerAll + the multi-domain-read
  // handlers (which need to filter their own output to the agent's
  // read allowlist).
  const resolved = resolveScopes(opts);
  const readScopes = resolved.readScopes;

  // Tool definitions — declarative table. registerAll filters and wraps
  // based on opts (readonly/noAudit/readScopes/writeScopes/agentId).
  // Multi-domain-read handlers (get_state, search_timeline, status)
  // additionally read `readScopes` from this closure to filter their
  // output when the caller did not constrain the request.
  const defs: ToolDef[] = [
    // --- Tool: usrcp_get_state -------------------------------------------
    {
      name: "usrcp_get_state",
      description:
        "Query the user's identity, preferences, active projects, domain context, and recent interaction timeline from their USRCP State Ledger. Use this at the start of a session to understand who the user is and what they've been working on across all AI platforms.",
      mutating: false,
      kind: "multi-domain-read",
      scopeOf: (p) =>
        Array.isArray(p.timeline_domains) && p.timeline_domains.length > 0
          ? p.timeline_domains
          : "all",
      inputShape: {
        scopes: z
          .array(
            z.enum([
              "core_identity",
              "global_preferences",
              "recent_timeline",
              "domain_context",
              "active_projects",
            ])
          )
          .max(5)
          .default([
            "core_identity",
            "global_preferences",
            "recent_timeline",
            "domain_context",
            "active_projects",
          ])
          .describe("Which facets of user state to retrieve"),
        timeline_last_n: z
          .number()
          .min(1)
          .max(500)
          .default(20)
          .optional()
          .describe("Number of recent timeline events to retrieve"),
        timeline_since: z
          .string()
          .max(30)
          .optional()
          .describe(
            "ISO 8601 timestamp — retrieve timeline events after this time"
          ),
        timeline_domains: z
          .array(z.string().max(MAX_STRING_SHORT))
          .max(20)
          .optional()
          .describe(
            "Filter timeline to specific domains (e.g., ['coding', 'writing'])"
          ),
        caller: z
          .string()
          .max(MAX_STRING_SHORT)
          .default("unknown")
          .describe("Identifying name of the calling agent/platform"),
      },
      handler: async (params) => {
        // If read-scope-restricted and the caller did not pass
        // timeline_domains, inject the read allowlist so we don't
        // leak events from other domains.
        if (
          readScopes &&
          (!params.timeline_domains || params.timeline_domains.length === 0)
        ) {
          params.timeline_domains = [...readScopes];
        }

        const state = ledger.getState(params.scopes);

        if (
          params.scopes.includes("recent_timeline") &&
          (params.timeline_last_n ||
            params.timeline_since ||
            params.timeline_domains)
        ) {
          state.recent_timeline = ledger.getTimeline({
            last_n: params.timeline_last_n,
            since: params.timeline_since,
            domains: params.timeline_domains,
          });
        }

        // Post-filter the per-domain facets so a read-scoped agent never
        // sees projects or context for domains outside its read allowlist.
        if (readScopes) {
          if (state.active_projects) {
            state.active_projects = state.active_projects.filter((p) =>
              readScopes.includes(p.domain)
            );
          }
          if (state.domain_context) {
            state.domain_context = Object.fromEntries(
              Object.entries(state.domain_context).filter(([d]) =>
                readScopes.includes(d)
              )
            );
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  usrcp_version: "0.1.0",
                  user_id: formatUserId(identity?.user_id),
                  resolved_at: new Date().toISOString(),
                  state,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_append_event ----------------------------------------
    {
      name: "usrcp_append_event",
      description:
        "Record an interaction event to the user's USRCP State Ledger. Call this when a meaningful interaction completes — a task finished, a decision made, a file created, a bug fixed. This builds the user's cross-platform interaction history.",
      mutating: true,
      kind: "domain-scoped",
      scopeOf: (p) => [p.domain],
      inputShape: {
        domain: z
          .string()
          .max(MAX_STRING_SHORT)
          .describe(
            "Semantic domain: coding, writing, research, design, personal, health, finance, etc."
          ),
        summary: z
          .string()
          .max(MAX_STRING_LONG)
          .describe("Concise summary of what happened"),
        intent: z
          .string()
          .max(MAX_STRING_MEDIUM)
          .describe("What the user was trying to accomplish"),
        outcome: z
          .enum(["success", "partial", "failed", "abandoned"])
          .describe("How the interaction resolved"),
        platform: z
          .string()
          .max(MAX_STRING_SHORT)
          .default("unknown")
          .describe(
            "Platform this event originated from (e.g., 'claude_code', 'cursor')"
          ),
        detail: boundedRecord()
          .optional()
          .describe("Structured detail blob — varies by domain"),
        artifacts: z
          .array(
            z.object({
              type: z.enum([
                "file",
                "url",
                "git_commit",
                "document",
                "image",
                "other",
              ]),
              ref: z.string().max(MAX_STRING_URI),
              label: z.string().max(MAX_STRING_MEDIUM).optional(),
            })
          )
          .max(MAX_ARRAY_ITEMS)
          .optional()
          .describe("References to outputs (files, commits, URLs)"),
        tags: z
          .array(z.string().max(MAX_STRING_SHORT))
          .max(MAX_ARRAY_ITEMS)
          .optional()
          .describe("Freeform tags for filtering and search"),
        session_id: z
          .string()
          .max(MAX_STRING_SHORT)
          .optional()
          .describe("Session identifier to group related events"),
        idempotency_key: z
          .string()
          .max(MAX_STRING_SHORT)
          .optional()
          .describe(
            "Client-generated key to prevent duplicate writes on retry"
          ),
      },
      handler: async (params) => {
        const { platform, idempotency_key, ...eventInput } = params;
        const result = ledger.appendEvent(
          eventInput,
          platform,
          idempotency_key,
          opts.agentId ?? platform
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  usrcp_version: "0.1.0",
                  status: result.duplicate ? "duplicate" : "accepted",
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_update_identity -------------------------------------
    {
      name: "usrcp_update_identity",
      description:
        "Update the user's core identity in the USRCP State Ledger. Use when you learn new information about the user — their role, expertise, or communication preferences.",
      mutating: true,
      kind: "global-mutation",
      inputShape: {
        display_name: z
          .string()
          .max(MAX_STRING_MEDIUM)
          .optional()
          .describe("User's display name"),
        roles: z
          .array(z.string().max(MAX_STRING_SHORT))
          .max(20)
          .optional()
          .describe("User's roles (e.g., ['founder', 'software_engineer'])"),
        expertise_domains: z
          .array(
            z.object({
              domain: z.string().max(MAX_STRING_SHORT),
              level: z.enum([
                "beginner",
                "intermediate",
                "advanced",
                "expert",
              ]),
            })
          )
          .max(MAX_ARRAY_ITEMS)
          .optional()
          .describe("User's expertise areas and levels"),
        communication_style: z
          .enum(["concise", "detailed", "socratic", "pair_programming"])
          .optional()
          .describe("How the user prefers AI to communicate"),
        expected_version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Optional: version from a prior read. If the stored version differs, " +
              "the update is rejected with VERSION_CONFLICT. Use for read-modify-write flows."
          ),
      },
      handler: async (params) => {
        const update: Partial<CoreIdentity> = {};
        if (params.display_name !== undefined)
          update.display_name = params.display_name;
        if (params.roles !== undefined) update.roles = params.roles;
        if (params.expertise_domains !== undefined)
          update.expertise_domains = params.expertise_domains;
        if (params.communication_style !== undefined)
          update.communication_style = params.communication_style;

        try {
          ledger.updateIdentity(update, params.expected_version);
        } catch (err) {
          if (err instanceof VersionConflictError) return versionConflictResponse(err);
          throw err;
        }
        const updated = ledger.getIdentity();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "updated", core_identity: updated },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_update_preferences ----------------------------------
    {
      name: "usrcp_update_preferences",
      description:
        "Update the user's global preferences in the USRCP State Ledger. These preferences apply across all AI platforms.",
      mutating: true,
      kind: "global-mutation",
      inputShape: {
        language: z
          .string()
          .max(10)
          .optional()
          .describe("Preferred language code (e.g., 'en')"),
        timezone: z
          .string()
          .max(50)
          .optional()
          .describe("IANA timezone (e.g., 'America/Los_Angeles')"),
        output_format: z
          .enum(["markdown", "plain", "structured"])
          .optional()
          .describe("Preferred output format"),
        verbosity: z
          .enum(["minimal", "standard", "verbose"])
          .optional()
          .describe("Preferred verbosity level"),
        custom: boundedRecord()
          .optional()
          .describe("Custom key-value preferences"),
        expected_version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Optional: version from a prior read. If the stored version differs, " +
              "the update is rejected with VERSION_CONFLICT."
          ),
      },
      handler: async (params) => {
        const update: Partial<GlobalPreferences> = {};
        if (params.language !== undefined) update.language = params.language;
        if (params.timezone !== undefined) update.timezone = params.timezone;
        if (params.output_format !== undefined)
          update.output_format = params.output_format;
        if (params.verbosity !== undefined) update.verbosity = params.verbosity;
        if (params.custom !== undefined)
          update.custom = params.custom as Record<string, unknown>;

        try {
          ledger.updatePreferences(update, params.expected_version);
        } catch (err) {
          if (err instanceof VersionConflictError) return versionConflictResponse(err);
          throw err;
        }
        const updated = ledger.getPreferences();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "updated", global_preferences: updated },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_update_domain_context -------------------------------
    {
      name: "usrcp_update_domain_context",
      description:
        "Store or update domain-scoped context in the USRCP State Ledger. Use this to persist domain-specific knowledge that should be available to any agent working in that domain (e.g., coding preferences, writing style notes, research topics).",
      mutating: true,
      kind: "domain-scoped",
      scopeOf: (p) => [p.domain],
      inputShape: {
        domain: z
          .string()
          .max(MAX_STRING_SHORT)
          .describe(
            "Domain name (e.g., 'coding', 'writing', 'research', 'design')"
          ),
        context: boundedRecord().describe(
          "Key-value context to merge into the domain (e.g., { preferred_framework: 'nextjs', css: 'tailwind' })"
        ),
        expected_version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Optional: version from a prior read (0 = domain does not yet exist). " +
              "If the stored version differs, the update is rejected with VERSION_CONFLICT."
          ),
      },
      handler: async (params) => {
        try {
          ledger.upsertDomainContext(
            params.domain,
            params.context as Record<string, unknown>,
            params.expected_version
          );
        } catch (err) {
          if (err instanceof VersionConflictError) return versionConflictResponse(err);
          throw err;
        }
        const updated = ledger.getDomainContext([params.domain]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "updated",
                  domain: params.domain,
                  context: updated[params.domain],
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_search_timeline -------------------------------------
    {
      name: "usrcp_search_timeline",
      description:
        "Search the user's interaction timeline by keyword. Useful for finding past interactions, decisions, or context about specific topics.",
      mutating: false,
      kind: "multi-domain-read",
      scopeOf: (p) => (p.domain ? [p.domain] : "all"),
      inputShape: {
        query: z
          .string()
          .max(MAX_SEARCH_QUERY)
          .describe("Search query — matches against summary, intent, and tags"),
        domain: z
          .string()
          .max(MAX_STRING_SHORT)
          .optional()
          .describe("Filter to a specific domain"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .optional()
          .describe("Max results"),
        caller: z
          .string()
          .max(MAX_STRING_SHORT)
          .default("unknown")
          .describe("Identifying name of the calling agent/platform"),
      },
      handler: async (params) => {
        let results;
        if (readScopes && !params.domain) {
          // Run a per-scope search and merge — searchTimeline only takes a
          // single domain filter, but a read-scoped agent can search across
          // all its allowed domains in one call.
          const merged: any[] = [];
          const seen = new Set<string>();
          for (const d of readScopes) {
            const r = ledger.searchTimeline(params.query, {
              limit: params.limit,
              domain: d,
            });
            for (const ev of r) {
              if (!seen.has(ev.event_id)) {
                seen.add(ev.event_id);
                merged.push(ev);
              }
            }
          }
          merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          results = merged.slice(0, params.limit ?? 20);
        } else {
          results = ledger.searchTimeline(params.query, {
            limit: params.limit,
            domain: params.domain,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query: params.query,
                  result_count: results.length,
                  events: results,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_manage_project --------------------------------------
    {
      name: "usrcp_manage_project",
      description:
        "Create or update a project in the user's USRCP State Ledger. Projects track what the user is actively working on across platforms.",
      mutating: true,
      kind: "domain-scoped",
      scopeOf: (p) => [p.domain],
      inputShape: {
        project_id: z
          .string()
          .max(MAX_STRING_SHORT)
          .describe(
            "Unique project identifier (e.g., 'usrcp', 'blog-redesign')"
          ),
        name: z
          .string()
          .max(MAX_STRING_MEDIUM)
          .describe("Human-readable project name"),
        domain: z
          .string()
          .max(MAX_STRING_SHORT)
          .describe("Project domain (coding, writing, research, etc.)"),
        status: z
          .enum(["active", "paused", "completed"])
          .default("active")
          .describe("Project status"),
        summary: z
          .string()
          .max(MAX_STRING_LONG)
          .describe("Brief project description or current state"),
      },
      handler: async (params) => {
        ledger.upsertProject({
          ...params,
          last_touched: new Date().toISOString(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "updated", project: params },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_audit_log -------------------------------------------
    {
      name: "usrcp_audit_log",
      description:
        "View the USRCP audit log — every read, write, search, and delete operation recorded with timestamps, agent identity, and scopes accessed.",
      mutating: false,
      kind: "audit-read",
      inputShape: {
        limit: z
          .number()
          .min(1)
          .max(500)
          .default(50)
          .optional()
          .describe("Number of audit log entries to retrieve"),
      },
      handler: async (params) => {
        const entries = ledger.getAuditLog(params.limit);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total_entries: entries.length,
                  entries,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_rotate_key ------------------------------------------
    {
      name: "usrcp_rotate_key",
      description:
        "Rotate the master encryption key. Re-encrypts ALL data in the ledger with a new key. Use when the current key may be compromised or as part of regular key hygiene.",
      mutating: true,
      kind: "global-mutation",
      inputShape: {
        new_passphrase: z
          .string()
          .max(MAX_STRING_MEDIUM)
          .optional()
          .describe(
            "New passphrase for key derivation. If omitted, generates a random key (dev mode)."
          ),
      },
      handler: async (params) => {
        try {
          // Capture adapter-config re-encryption results out of the
          // hook so we can surface them on the response. The hook
          // runs inside rotateKey AFTER commit but BEFORE in-memory
          // masterKey is swapped, so the buffers are still live.
          let adapterResult: AdapterReencryptResult | undefined;
          const result = ledger.rotateKey(params.new_passphrase, {
            onKeysReady: (oldKey, newKey) => {
              adapterResult = reencryptAdapterConfigs({ oldKey, newKey });
            },
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "rotated",
                    version: result.version,
                    reencrypted: result.reencrypted,
                    skipped: result.skipped,
                    adapter_configs: adapterResult ?? {
                      rotated: [],
                      absent: [],
                      failed: [],
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "failed",
                    error: err.message || "Key rotation failed",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      },
    },

    // --- Tool: usrcp_set_fact --------------------------------------------
    {
      name: "usrcp_set_fact",
      description:
        "Store a free-form fact in a domain namespace. Use for data the fixed schema doesn't model (habits, relationships, recurring tasks, mood, goals, etc.). Upserts one row per (domain, namespace, key) — re-calling with the same key overwrites. All values are encrypted with the domain-scoped key.",
      mutating: true,
      kind: "domain-scoped",
      scopeOf: (p) => [p.domain],
      inputShape: {
        domain: z
          .string()
          .min(1)
          .max(MAX_STRING_SHORT)
          .describe("Semantic domain (coding, personal, health, etc.)"),
        namespace: z
          .string()
          .min(1)
          .max(MAX_STRING_SHORT)
          .describe("Namespace within the domain (e.g., 'habits', 'relationships')"),
        key: z
          .string()
          .min(1)
          .max(MAX_STRING_MEDIUM)
          .describe("Key within the namespace (e.g., 'morning_routine')"),
        value: z
          .unknown()
          .describe("Free-form value — any JSON-serializable data"),
        expected_version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Optional: version from a prior read (0 = fact does not yet exist). " +
              "If the stored version differs, the write is rejected with VERSION_CONFLICT."
          ),
        caller: z
          .string()
          .max(MAX_STRING_SHORT)
          .default("unknown")
          .describe("Identifying name of the calling agent/platform"),
      },
      handler: async (params) => {
        let result;
        try {
          result = ledger.setFact(
            params.domain,
            params.namespace,
            params.key,
            params.value,
            {
              expectedVersion: params.expected_version,
              agentId: opts.agentId ?? params.caller,
            }
          );
        } catch (err) {
          if (err instanceof VersionConflictError) return versionConflictResponse(err);
          throw err;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: result.created ? "created" : "updated",
                  fact_id: result.fact_id,
                  updated_at: result.updated_at,
                  version: result.version,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_get_facts -------------------------------------------
    {
      name: "usrcp_get_facts",
      description:
        "Read schemaless facts. If `key` is provided, returns a single fact; otherwise lists all facts in the domain (optionally filtered by namespace).",
      mutating: false,
      kind: "domain-scoped",
      scopeOf: (p) => [p.domain],
      inputShape: {
        domain: z
          .string()
          .min(1)
          .max(MAX_STRING_SHORT)
          .describe("Domain to read from"),
        namespace: z
          .string()
          .max(MAX_STRING_SHORT)
          .optional()
          .describe("Optional: filter by namespace"),
        key: z
          .string()
          .max(MAX_STRING_MEDIUM)
          .optional()
          .describe("Optional: fetch a single fact by key (namespace required if set)"),
      },
      handler: async (params) => {
        if (params.key !== undefined) {
          if (params.namespace === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: "namespace required when key is provided" },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          const fact = ledger.getFact(params.domain, params.namespace, params.key);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ fact }, null, 2),
              },
            ],
          };
        }
        const facts = ledger.listFacts(params.domain, params.namespace);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: facts.length, facts }, null, 2),
            },
          ],
        };
      },
    },

    // --- Tool: usrcp_status ----------------------------------------------
    {
      name: "usrcp_status",
      description:
        "Get the status and statistics of the local USRCP ledger — total events, domains, platforms, and projects.",
      mutating: false,
      kind: "global-read",
      inputShape: {},
      handler: async () => {
        // Read-scope filtering: a read-scoped agent must not see
        // ledger-wide totals, domain names, or platform names outside
        // its authorized read allowlist.
        if (readScopes) {
          const scopedStats = ledger.getStatsForScopes(readScopes);
          const allowed = new Set(readScopes);
          const scopedActiveProjects = ledger
            .getProjects()
            .filter((p) => p.status === "active" && allowed.has(p.domain))
            .length;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    usrcp_version: "0.1.0",
                    user_id: formatUserId(identity?.user_id),
                    ledger: "local (SQLite)",
                    scoped: true,
                    allowed_domains: readScopes,
                    stats: scopedStats,
                    active_projects: scopedActiveProjects,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const stats = ledger.getStats();
        const projects = ledger.getProjects();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  usrcp_version: "0.1.0",
                  user_id: formatUserId(identity?.user_id),
                  ledger: "local (SQLite)",
                  stats,
                  active_projects: projects.filter(
                    (p) => p.status === "active"
                  ).length,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },
  ];

  registerAll(server, defs, opts, ledger);

  // Optional sibling: usrcp-stream registers its own MCP tools onto the
  // same server when the package is installed. Sharing the masterKey
  // (via ledger.getMasterKey()) means stream's per-domain HKDF keys
  // ride the same passphrase as the ledger; the user only ever derives
  // the master key once per process. Failures during stream registration
  // log and continue; the ledger keeps serving regardless.
  let streamShutdown: (() => void) | null = null;
  try {
    // usrcp-stream is an optional peer, not a declared dependency. If
    // the package isn't installed, MODULE_NOT_FOUND comes back and we
    // silently skip. Any *other* error means stream IS present but
    // failed to register, and we log it loudly so misconfigurations
    // don't disappear.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const streamMod = require("usrcp-stream/dist/register.js") as any;
    if (streamMod && typeof streamMod.registerStreamTools === "function") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getUserDir } = require("./encryption.js");
      const reg = streamMod.registerStreamTools(server, {
        masterKey: ledger.getMasterKey(),
        ledger,
        userDir: getUserDir(),
        serveOptions: opts,
      });
      streamShutdown = reg.shutdown;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "MODULE_NOT_FOUND" && e?.code !== "ERR_MODULE_NOT_FOUND") {
      console.error(
        "[usrcp] usrcp-stream is installed but failed to register:",
        e
      );
    }
  }

  const wrappedShutdown = () => {
    if (streamShutdown) {
      try {
        streamShutdown();
      } catch {}
    }
    shutdown();
  };

  return { server, shutdown: wrappedShutdown, ledger };
}

// ----------------------------------------------------------------------------
// registerAll — applies opts (readonly/noAudit/scopes/agentId) to the table
// ----------------------------------------------------------------------------

function registerAll(
  server: McpServer,
  defs: ToolDef[],
  opts: ServeOptions,
  ledger: Ledger
): void {
  const { readScopes, writeScopes } = resolveScopes(opts);
  // A mutating tool is stripped entirely (not registered) when writes
  // are disallowed across all domains - i.e. `writeScopes === []`,
  // which is either `--readonly` or explicit `--write-scopes=`. With
  // `writeScopes` undefined (unrestricted) or a non-empty array, the
  // tool registers and the wrapper gates per-domain.
  const writesAllDenied = writeScopes !== undefined && writeScopes.length === 0;

  // Wrapper-layer audit fires only when the operator has explicitly opted
  // into scoped mode (any flag set). The unflagged default path keeps the
  // pre-refactor audit-row volume so existing single-agent setups don't
  // see a behavior change.
  const scopedMode =
    readScopes !== undefined ||
    writeScopes !== undefined ||
    opts.noAudit === true ||
    opts.agentId !== undefined;
  const agentId = opts.agentId ?? "unidentified";

  // Compact display string for the audit row: distinguishes "all" from
  // "[a,b,c]" without coupling the audit format to the read/write split.
  const formatScopeArr = (s: string[] | undefined): string =>
    s === undefined ? "*" : s.length === 0 ? "[]" : `[${s.join(",")}]`;
  const auditScopeRepr = `read=${formatScopeArr(readScopes)};write=${formatScopeArr(writeScopes)}`;

  for (const def of defs) {
    // Registration-time filtering: tools that the caller has opted out of
    // are not registered at all, so they do not appear in tools/list.
    if (writesAllDenied && def.mutating) continue;
    if (opts.noAudit && def.kind === "audit-read") continue;

    const wrappedHandler = async (params: any) => {
      if (scopedMode) {
        // One audit row per MCP call, tagged with the agent_id. This is
        // separate from the ledger's internal per-write logAudit and
        // captures reads as well — the point of scoped mode is per-agent
        // attribution across the full call surface.
        ledger.logAudit(
          `mcp_call:${def.name}`,
          auditScopeRepr,
          undefined,
          undefined,
          undefined,
          agentId
        );
      }

      // Mutating tools check writeScopes; read tools check readScopes.
      // The two enforcement paths look identical, but distinguishing
      // them is what enables asymmetric permissions ("read everything,
      // write only personal").
      const effective = def.mutating ? writeScopes : readScopes;

      // Scope enforcement
      if (effective) {
        if (def.kind === "global-mutation") {
          // Any restricted writeScopes (even non-empty) bars
          // global mutations - they touch state shared across all
          // domains. The audit-displayed allowlist is writeScopes
          // since this is a write-class tool.
          return outOfScopeResponse(def.name, ["<global>"], effective);
        }
        if (def.kind === "domain-scoped" && def.scopeOf) {
          const requested = def.scopeOf(params) as string[];
          const out = requested.filter((d) => !effective.includes(d));
          if (out.length > 0) {
            return outOfScopeResponse(def.name, out, effective);
          }
        }
        if (def.kind === "multi-domain-read" && def.scopeOf) {
          const requested = def.scopeOf(params);
          if (requested !== "all") {
            const out = (requested as string[]).filter(
              (d) => !effective.includes(d)
            );
            if (out.length > 0) {
              return outOfScopeResponse(def.name, out, effective);
            }
          }
          // If "all", the handler reads `readScopes` from its closure
          // and filters its own output - the wrapper does not inject
          // anything here.
        }
      }

      return def.handler(params);
    };

    server.tool(def.name, def.description, def.inputShape, wrappedHandler);
  }
}
