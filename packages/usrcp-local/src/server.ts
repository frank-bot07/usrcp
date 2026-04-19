import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ledger } from "./ledger.js";
import { getIdentity } from "./crypto.js";
import type { CoreIdentity, GlobalPreferences } from "./types.js";

// --- Security constants ---
const MAX_STRING_SHORT = 100; // identifiers, domains, keys
const MAX_STRING_MEDIUM = 300; // intents, names, summaries
const MAX_STRING_LONG = 500; // summaries, descriptions
const MAX_STRING_URI = 2048; // URIs and refs
const MAX_ARRAY_ITEMS = 50; // tags, artifacts, expertise
const MAX_RECORD_KEYS = 50; // detail blobs, custom prefs, domain context
const MAX_SEARCH_QUERY = 200; // search input

function formatUserId(rawId: string | undefined): string {
  return `usrcp://local/${rawId || "anonymous"}`;
}

// Constrained record type: limits both key count and value size
function boundedRecord() {
  return z
    .record(z.string().max(MAX_STRING_SHORT), z.unknown())
    .refine((obj) => Object.keys(obj).length <= MAX_RECORD_KEYS, {
      message: `Record must have at most ${MAX_RECORD_KEYS} keys`,
    });
}

export function createServer(passphrase?: string): { server: McpServer; shutdown: () => void; ledger: Ledger } {
  const ledger = new Ledger(undefined, passphrase);
  const identity = getIdentity();

  const shutdown = () => {
    ledger.close();
  };

  const server = new McpServer({
    name: "usrcp-local",
    version: "0.1.0",
  });

  // --- Tool: usrcp_get_state ---
  server.tool(
    "usrcp_get_state",
    "Query the user's identity, preferences, active projects, domain context, and recent interaction timeline from their USRCP State Ledger. Use this at the start of a session to understand who the user is and what they've been working on across all AI platforms.",
    {
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
    async (params) => {
      ledger.setAgentId(params.caller);
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
    }
  );

  // --- Tool: usrcp_append_event ---
  server.tool(
    "usrcp_append_event",
    "Record an interaction event to the user's USRCP State Ledger. Call this when a meaningful interaction completes — a task finished, a decision made, a file created, a bug fixed. This builds the user's cross-platform interaction history.",
    {
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
    async (params) => {
      const { platform, idempotency_key, ...eventInput } = params;
      ledger.setAgentId(platform);
      const result = ledger.appendEvent(eventInput, platform, idempotency_key);

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
    }
  );

  // --- Tool: usrcp_update_identity ---
  server.tool(
    "usrcp_update_identity",
    "Update the user's core identity in the USRCP State Ledger. Use when you learn new information about the user — their role, expertise, or communication preferences.",
    {
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
    },
    async (params) => {
      const update: Partial<CoreIdentity> = {};
      if (params.display_name !== undefined)
        update.display_name = params.display_name;
      if (params.roles !== undefined) update.roles = params.roles;
      if (params.expertise_domains !== undefined)
        update.expertise_domains = params.expertise_domains;
      if (params.communication_style !== undefined)
        update.communication_style = params.communication_style;

      ledger.updateIdentity(update);
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
    }
  );

  // --- Tool: usrcp_update_preferences ---
  server.tool(
    "usrcp_update_preferences",
    "Update the user's global preferences in the USRCP State Ledger. These preferences apply across all AI platforms.",
    {
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
    },
    async (params) => {
      const update: Partial<GlobalPreferences> = {};
      if (params.language !== undefined) update.language = params.language;
      if (params.timezone !== undefined) update.timezone = params.timezone;
      if (params.output_format !== undefined)
        update.output_format = params.output_format;
      if (params.verbosity !== undefined) update.verbosity = params.verbosity;
      if (params.custom !== undefined)
        update.custom = params.custom as Record<string, unknown>;

      ledger.updatePreferences(update);
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
    }
  );

  // --- Tool: usrcp_update_domain_context ---
  server.tool(
    "usrcp_update_domain_context",
    "Store or update domain-scoped context in the USRCP State Ledger. Use this to persist domain-specific knowledge that should be available to any agent working in that domain (e.g., coding preferences, writing style notes, research topics).",
    {
      domain: z
        .string()
        .max(MAX_STRING_SHORT)
        .describe(
          "Domain name (e.g., 'coding', 'writing', 'research', 'design')"
        ),
      context: boundedRecord().describe(
        "Key-value context to merge into the domain (e.g., { preferred_framework: 'nextjs', css: 'tailwind' })"
      ),
    },
    async (params) => {
      ledger.upsertDomainContext(
        params.domain,
        params.context as Record<string, unknown>
      );
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
    }
  );

  // --- Tool: usrcp_search_timeline ---
  server.tool(
    "usrcp_search_timeline",
    "Search the user's interaction timeline by keyword. Useful for finding past interactions, decisions, or context about specific topics.",
    {
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
    async (params) => {
      ledger.setAgentId(params.caller);
      const results = ledger.searchTimeline(params.query, {
        limit: params.limit,
        domain: params.domain,
      });

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
    }
  );

  // --- Tool: usrcp_manage_project ---
  server.tool(
    "usrcp_manage_project",
    "Create or update a project in the user's USRCP State Ledger. Projects track what the user is actively working on across platforms.",
    {
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
    async (params) => {
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
    }
  );

  // --- Tool: usrcp_audit_log ---
  server.tool(
    "usrcp_audit_log",
    "View the USRCP audit log — every read, write, search, and delete operation recorded with timestamps, agent identity, and scopes accessed.",
    {
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(50)
        .optional()
        .describe("Number of audit log entries to retrieve"),
    },
    async (params) => {
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
    }
  );

  // --- Tool: usrcp_rotate_key ---
  server.tool(
    "usrcp_rotate_key",
    "Rotate the master encryption key. Re-encrypts ALL data in the ledger with a new key. Use when the current key may be compromised or as part of regular key hygiene.",
    {
      new_passphrase: z
        .string()
        .max(MAX_STRING_MEDIUM)
        .optional()
        .describe(
          "New passphrase for key derivation. If omitted, generates a random key (dev mode)."
        ),
    },
    async (params) => {
      const result = ledger.rotateKey(params.new_passphrase);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "rotated",
                key_version: result.version,
                events_reencrypted: result.reencrypted,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- Tool: usrcp_status ---
  server.tool(
    "usrcp_status",
    "Get the status and statistics of the local USRCP ledger — total events, domains, platforms, and projects.",
    {},
    async () => {
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
    }
  );

  return { server, shutdown, ledger };
}
