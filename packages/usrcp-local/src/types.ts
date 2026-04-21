export interface CoreIdentity {
  display_name: string;
  roles: string[];
  expertise_domains: ExpertiseDomain[];
  communication_style: "concise" | "detailed" | "socratic" | "pair_programming";
}

export interface ExpertiseDomain {
  domain: string;
  level: "beginner" | "intermediate" | "advanced" | "expert";
}

export interface GlobalPreferences {
  language: string;
  timezone: string;
  output_format: "markdown" | "plain" | "structured";
  verbosity: "minimal" | "standard" | "verbose";
  custom: Record<string, unknown>;
}

export interface TimelineEvent {
  event_id: string;
  timestamp: string;
  platform: string;
  domain: string;
  summary: string;
  intent?: string;
  outcome?: "success" | "partial" | "failed" | "abandoned";
  detail?: Record<string, unknown>;
  artifacts?: Artifact[];
  tags?: string[];
  session_id?: string;
  parent_event_id?: string;
}

export interface Artifact {
  type: "file" | "url" | "git_commit" | "document" | "image" | "other";
  ref: string;
  label?: string;
}

export interface ActiveProject {
  project_id: string;
  name: string;
  domain: string;
  status: "active" | "paused" | "completed";
  last_touched: string;
  summary: string;
}

export interface DomainContext {
  domain: string;
  context: Record<string, unknown>;
  updated_at: string;
}

export interface UserState {
  core_identity?: CoreIdentity;
  global_preferences?: GlobalPreferences;
  recent_timeline?: TimelineEvent[];
  domain_context?: Record<string, Record<string, unknown>>;
  active_projects?: ActiveProject[];
}

export type Scope =
  | "core_identity"
  | "global_preferences"
  | "recent_timeline"
  | "domain_context"
  | "active_projects";

export interface TamperTracker {
  count: number;
  lastTamper: string | null;
  sessionId: string;
}

export interface SchemaFact {
  fact_id: string;
  domain: string;
  namespace: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
  version: number;
}

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT" as const;
  constructor(
    public readonly scope: string,
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
    public readonly target?: string
  ) {
    super(
      `Version conflict on ${scope}${target ? `:${target}` : ""} — ` +
      `expected v${expectedVersion}, current is v${currentVersion}`
    );
    this.name = "VersionConflictError";
  }
}

export interface AppendEventInput {
  domain: string;
  summary: string;
  intent: string;
  outcome: "success" | "partial" | "failed" | "abandoned";
  detail?: Record<string, unknown>;
  artifacts?: Artifact[];
  tags?: string[];
  session_id?: string;
  parent_event_id?: string;
  idempotency_key?: string;
}
