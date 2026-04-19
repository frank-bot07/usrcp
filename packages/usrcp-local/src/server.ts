import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ledger } from "./ledger.js";
import { getIdentity } from "./crypto.js";

export function createServer(): McpServer {
  const ledger = new Ledger();
  const identity = getIdentity();

  const server = new McpServer({
    name: "usrcp-local",
    version: "0.1.0",
  });

  // --- Tool: usrcp_get_state ---
  server.tool(
    "usrcp_get_state",
    "Query the user's identity, preferences, active projects, and recent interaction timeline from their USRCP State Ledger. Use this at the start of a session to understand who the user is and what they've been working on across all AI platforms.",
    {
      scopes: z
        .array(
          z.enum([
            "core_identity",
            "global_preferences",
            "recent_timeline",
            "active_projects",
          ])
        )
        .default([
          "core_identity",
          "global_preferences",
          "recent_timeline",
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
      timeline_domains: z
        .array(z.string())
        .optional()
        .describe("Filter timeline to specific domains (e.g., ['coding', 'writing'])"),
    },
    async (params) => {
      const state = ledger.getState(params.scopes);

      if (
        params.scopes.includes("recent_timeline") &&
        (params.timeline_last_n || params.timeline_domains)
      ) {
        state.recent_timeline = ledger.getTimeline({
          last_n: params.timeline_last_n,
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
                user_id: identity?.user_id || "local",
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
        .describe(
          "Semantic domain: coding, writing, research, design, personal, health, finance, etc."
        ),
      summary: z
        .string()
        .max(500)
        .describe("Concise summary of what happened"),
      intent: z
        .string()
        .max(300)
        .describe("What the user was trying to accomplish"),
      outcome: z
        .enum(["success", "partial", "failed", "abandoned"])
        .describe("How the interaction resolved"),
      platform: z
        .string()
        .default("unknown")
        .describe("Platform this event originated from (e.g., 'claude_code', 'cursor')"),
      detail: z
        .record(z.string(), z.unknown())
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
            ref: z.string(),
            label: z.string().optional(),
          })
        )
        .optional()
        .describe("References to outputs (files, commits, URLs)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Freeform tags for filtering and search"),
      session_id: z.string().optional().describe("Session identifier to group related events"),
    },
    async (params) => {
      const { platform, ...eventInput } = params;
      const result = ledger.appendEvent(eventInput, platform);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                usrcp_version: "0.1.0",
                status: "accepted",
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
      display_name: z.string().optional().describe("User's display name"),
      roles: z
        .array(z.string())
        .optional()
        .describe("User's roles (e.g., ['founder', 'software_engineer'])"),
      expertise_domains: z
        .array(
          z.object({
            domain: z.string(),
            level: z.enum(["beginner", "intermediate", "advanced", "expert"]),
          })
        )
        .optional()
        .describe("User's expertise areas and levels"),
      communication_style: z
        .enum(["concise", "detailed", "socratic", "pair_programming"])
        .optional()
        .describe("How the user prefers AI to communicate"),
    },
    async (params) => {
      ledger.updateIdentity(params as any);
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
      language: z.string().optional().describe("Preferred language code (e.g., 'en')"),
      timezone: z.string().optional().describe("IANA timezone (e.g., 'America/Los_Angeles')"),
      output_format: z
        .enum(["markdown", "plain", "structured"])
        .optional()
        .describe("Preferred output format"),
      verbosity: z
        .enum(["minimal", "standard", "verbose"])
        .optional()
        .describe("Preferred verbosity level"),
      custom: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Custom key-value preferences"),
    },
    async (params) => {
      ledger.updatePreferences(params as any);
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

  // --- Tool: usrcp_search_timeline ---
  server.tool(
    "usrcp_search_timeline",
    "Search the user's interaction timeline by keyword. Useful for finding past interactions, decisions, or context about specific topics.",
    {
      query: z.string().describe("Search query — matches against summary, intent, and tags"),
      domain: z.string().optional().describe("Filter to a specific domain"),
      limit: z.number().min(1).max(100).default(20).optional().describe("Max results"),
    },
    async (params) => {
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
      project_id: z.string().describe("Unique project identifier (e.g., 'usrcp', 'blog-redesign')"),
      name: z.string().describe("Human-readable project name"),
      domain: z.string().describe("Project domain (coding, writing, research, etc.)"),
      status: z.enum(["active", "paused", "completed"]).default("active").describe("Project status"),
      summary: z.string().describe("Brief project description or current state"),
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
                user_id: identity?.user_id || "local",
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

  return server;
}
