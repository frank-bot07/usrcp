import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Side effect: register the adapter-rotation recovery hook on usrcp-core's
// ledger before the server opens a Ledger.
import "./register-adapter-rotation-hook.js";
import { Ledger, RotationRateLimitedError, RotationDamagedRowsError } from "usrcp-core/ledger";
import { getIdentity } from "usrcp-core/crypto";
import { VersionConflictError } from "usrcp-core/types";
import type { CoreIdentity, GlobalPreferences } from "usrcp-core/types";
import {
  reencryptAdapterConfigs,
  type AdapterReencryptResult,
} from "./rotate-adapter-configs.js";
import { getUserDir } from "usrcp-core/encryption";

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
/**
 * Re-export the shared scope types so existing local-side consumers
 * (CLI flag parsing in index.ts, tests) keep their import paths.
 * The implementations live in scope-enforcement.ts so usrcp-stream
 * can share them without depending on this file (which pulls in
 * heavy MCP / ledger dependencies).
 */
export {
  type ServeOptions,
  type ResolvedScopes,
  type ToolKind,
  type ScopedToolDef,
  resolveScopes,
  registerToolsWithScopes,
} from "usrcp-core/scope-enforcement";

import {
  type ServeOptions,
  type ScopedToolDef,
  registerToolsWithScopes,
  projectStateResult,
  projectSearchResult,
  buildScopedStatusPayload,
} from "usrcp-core/scope-enforcement";

// Local alias - everything in this file used to call it ToolDef.
type ToolDef = ScopedToolDef;

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

function boundedRecord() {
  return z
    .record(z.string().max(MAX_STRING_SHORT), z.unknown())
    .refine((obj) => Object.keys(obj).length <= MAX_RECORD_KEYS, {
      message: `Record must have at most ${MAX_RECORD_KEYS} keys`,
    });
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
    version: "0.2.5",
  });

  // Tool definitions — declarative table. registerToolsWithScopes filters
  // and wraps based on opts (readonly/noAudit/readScopes/writeScopes/
  // agentId). Cross-domain read handlers (get_state, search_timeline,
  // status) are scope-UNAWARE: they always produce full output and declare
  // a `readProjection`. The wrapper applies that projection centrally to
  // redact output to the read allowlist (and refuses to register a
  // cross-domain read tool that omits one). Scope resolution happens once,
  // inside registerToolsWithScopes — handlers no longer re-resolve it.
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
      // Scope-unaware: always produces full state. The wrapper redacts to
      // the read allowlist via `readProjection` (projectStateResult) when
      // the server is read-scoped. The redaction rules (drop globals,
      // filter per-domain facets) live in scope-enforcement.ts so they
      // can't drift per-handler — the v0.1.3 globals leak was exactly that
      // drift. Explicit out-of-scope `timeline_domains` is still rejected
      // at the input layer by the wrapper (scopeOf), before this runs.
      readProjection: projectStateResult,
      handler: async (params) => {
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

        return {
          usrcp_version: "0.2.5",
          user_id: formatUserId(identity?.user_id),
          resolved_at: new Date().toISOString(),
          state,
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
                  usrcp_version: "0.2.5",
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
      // Scope-unaware: searches the full ledger (or the caller's explicit
      // in-scope `domain`, which the wrapper already gated at the input
      // layer). The wrapper redacts results to the read allowlist via
      // `readProjection` (projectSearchResult) when read-scoped.
      readProjection: projectSearchResult,
      handler: async (params) => {
        const results = ledger.searchTimeline(params.query, {
          limit: params.limit,
          domain: params.domain,
        });

        return {
          query: params.query,
          result_count: results.length,
          events: results,
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
            "Stable handle for the project (the upsert key). Stored as an opaque HMAC — the id itself is never persisted or synced in the clear — so any string is safe. The human-readable title goes in `name`."
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
        "Rotate the master encryption key. IRREVERSIBLE: replaces the on-disk master key and re-encrypts every row. DO NOT call this on your own initiative — only when the user has explicitly asked to rotate, or to respond to a confirmed key-compromise event. Rate-limited to once per 24h by default; rows that fail MAC verification under the current key are NOT silently dropped (the call will return an error and refuse to advance unless force_skip_damaged=true).",
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
        force_rate_limit: z
          .boolean()
          .optional()
          .describe(
            "Bypass the 24h rate limit (USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS). Set true only when the user has explicitly asked to rotate again sooner."
          ),
        force_skip_damaged: z
          .boolean()
          .optional()
          .describe(
            "Proceed even when rows fail to decrypt under the current key. Those rows become permanently unreadable. Set true only after taking a snapshot and confirming the data loss is acceptable."
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
              // Pass userDir so a SIGKILL mid-loop leaves a recoverable
              // checkpoint at <userDir>/keys/adapter-rotation.json. The
              // next Ledger boot replays the pending adapters via
              // resumeAdapterRotationIfPending in core.ts.
              adapterResult = reencryptAdapterConfigs({
                oldKey,
                newKey,
                userDir: getUserDir(),
              });
            },
            force_rate_limit: params.force_rate_limit,
            force_skip_damaged: params.force_skip_damaged,
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
          if (err instanceof RotationRateLimitedError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "rate_limited",
                      error: err.message,
                      hours_since_last: err.hoursSinceLast,
                      min_interval_hours: err.minIntervalHours,
                      last_rotation_at: err.lastRotationAt,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
          if (err instanceof RotationDamagedRowsError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "damaged_rows_present",
                      error: err.message,
                      damaged_count: err.damagedCount,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
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
            isError: true,
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
      // Status reports aggregates (counts, domain/platform lists) that
      // can't be reconstructed by filtering the unscoped payload after the
      // fact — `stats` must be computed against the scope at query time.
      // So the projection re-derives the scope-safe figures from the
      // ledger (which it has in closure) rather than projecting `_full`,
      // and buildScopedStatusPayload owns the envelope shape so a scoped
      // caller never sees the unscoped totals. The handler stays
      // scope-unaware: it always returns the owner (unscoped) view, and
      // the wrapper swaps in the scoped envelope when read-scoped.
      readProjection: (_full, rs) =>
        buildScopedStatusPayload({
          usrcp_version: "0.2.5",
          user_id: formatUserId(identity?.user_id),
          stats: ledger.getStatsForScopes(rs),
          active_projects: ledger
            .getProjects()
            .filter((p) => p.status === "active" && rs.includes(p.domain))
            .length,
          allowed_domains: rs,
        }),
      handler: async () => {
        const stats = ledger.getStats();
        const projects = ledger.getProjects();

        return {
          usrcp_version: "0.2.5",
          user_id: formatUserId(identity?.user_id),
          ledger: "local (SQLite)",
          stats,
          active_projects: projects.filter((p) => p.status === "active").length,
        };
      },
    },
  ];

  registerToolsWithScopes(server, defs, opts, ledger);

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

// Scope-enforcement wrapper has been lifted into ./scope-enforcement.ts
// (shared with usrcp-stream). The local-side wiring above calls
// `registerToolsWithScopes(server, defs, opts, ledger)` directly.
