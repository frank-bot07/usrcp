import { Ledger } from "./core.js";
import type {
  CoreIdentity,
  GlobalPreferences,
  ActiveProject,
  TimelineEvent,
  UserState,
  Scope,
} from "../types.js";
import { safeJsonParse } from "./helpers.js";

declare module "./core.js" {
  interface Ledger {
    getIdentity(): CoreIdentity & {tampered?: boolean; version: number};
    updateIdentity(identity: Partial<CoreIdentity>, expectedVersion?: number): number;
    getPreferences(): GlobalPreferences & {tampered?: boolean; version: number};
    updatePreferences(prefs: Partial<GlobalPreferences>, expectedVersion?: number): number;
    getProjects(status?: string): (ActiveProject & {tampered?: boolean})[];
    upsertProject(project: ActiveProject): void;
    getDomainContext(domains?: string[]): Record<string, Record<string, unknown>>;
    getDomainContextVersion(domain: string): number;
    upsertDomainContext(domain: string, context: Record<string, unknown>, expectedVersion?: number): number;
    getState(scopes: Scope[]): UserState;
    // Forward declaration for getTimeline used by getState
    getTimeline(options?: { last_n?: number; since?: string; domains?: string[] }): TimelineEvent[];
  }
}

Ledger.prototype.getIdentity = function (
  this: Ledger
): CoreIdentity & {tampered?: boolean; version: number} {
  const row = this.db
    .prepare("SELECT * FROM core_identity WHERE id = 1")
    .get() as any;
  let tampered = false;

  const nameRes = this.safeDecryptGlobal(row.display_name || "", '', 'display_name');
  tampered ||= nameRes.tampered;
  const rolesRes = this.safeDecryptGlobal(row.roles || "[]", '[]', 'roles');
  const roles = safeJsonParse(rolesRes.value, []);
  tampered ||= rolesRes.tampered;
  const expertiseRes = this.safeDecryptGlobal(row.expertise_domains || "[]", '[]', 'expertise_domains');
  const expertise = safeJsonParse(expertiseRes.value, []);
  tampered ||= expertiseRes.tampered;
  const styleRes = this.safeDecryptGlobal(row.communication_style || "concise", 'concise', 'communication_style');
  tampered ||= styleRes.tampered;

  const result: CoreIdentity & {tampered?: boolean; version: number} = {
    display_name: nameRes.value,
    roles,
    expertise_domains: expertise,
    communication_style: styleRes.value as CoreIdentity["communication_style"],
    version: row.version ?? 1,
  };

  if (tampered) result.tampered = true;

  return result;
};

Ledger.prototype.updateIdentity = function (
  this: Ledger,
  identity: Partial<CoreIdentity>,
  expectedVersion?: number
): number {
  const current = this.getIdentity();
  this.checkExpectedVersion("core_identity", current.version, expectedVersion);
  const merged = { ...current, ...identity };
  const newVersion = current.version + 1;
  this.db
    .prepare(
      `UPDATE core_identity SET
        display_name = ?,
        roles = ?,
        expertise_domains = ?,
        communication_style = ?,
        version = ?,
        updated_at = datetime('now')
      WHERE id = 1`
    )
    .run(
      this.encryptGlobal(merged.display_name),
      this.encryptGlobal(JSON.stringify(merged.roles)),
      this.encryptGlobal(JSON.stringify(merged.expertise_domains)),
      this.encryptGlobal(merged.communication_style),
      newVersion
    );
  this.logAudit("update_identity");
  return newVersion;
};

Ledger.prototype.getPreferences = function (
  this: Ledger
): GlobalPreferences & {tampered?: boolean; version: number} {
  const row = this.db
    .prepare("SELECT * FROM global_preferences WHERE id = 1")
    .get() as any;
  let tampered = false;

  const langRes = this.safeDecryptGlobal(row.language || "en", 'en', 'language');
  tampered ||= langRes.tampered;
  const tzRes = this.safeDecryptGlobal(row.timezone || "UTC", 'UTC', 'timezone');
  tampered ||= tzRes.tampered;
  const formatRes = this.safeDecryptGlobal(row.output_format || "markdown", 'markdown', 'output_format');
  tampered ||= formatRes.tampered;
  const verbRes = this.safeDecryptGlobal(row.verbosity || "standard", 'standard', 'verbosity');
  tampered ||= verbRes.tampered;
  const customRes = this.safeDecryptGlobal(row.custom || "{}", '{}', 'custom');
  const custom = safeJsonParse(customRes.value, {});
  tampered ||= customRes.tampered;

  const result: GlobalPreferences & {tampered?: boolean; version: number} = {
    language: langRes.value,
    timezone: tzRes.value,
    output_format: formatRes.value as GlobalPreferences["output_format"],
    verbosity: verbRes.value as GlobalPreferences["verbosity"],
    custom,
    version: row.version ?? 1,
  };

  if (tampered) result.tampered = true;

  return result;
};

Ledger.prototype.updatePreferences = function (
  this: Ledger,
  prefs: Partial<GlobalPreferences>,
  expectedVersion?: number
): number {
  const current = this.getPreferences();
  this.checkExpectedVersion("global_preferences", current.version, expectedVersion);
  const merged = { ...current, ...prefs };
  if (prefs.custom) {
    merged.custom = { ...current.custom, ...prefs.custom };
  }
  const newVersion = current.version + 1;
  this.db
    .prepare(
      `UPDATE global_preferences SET
        language = ?,
        timezone = ?,
        output_format = ?,
        verbosity = ?,
        custom = ?,
        version = ?,
        updated_at = datetime('now')
      WHERE id = 1`
    )
    .run(
      this.encryptGlobal(merged.language),
      this.encryptGlobal(merged.timezone),
      this.encryptGlobal(merged.output_format),
      this.encryptGlobal(merged.verbosity),
      this.encryptGlobal(JSON.stringify(merged.custom)),
      newVersion
    );
  this.logAudit("update_preferences");
  return newVersion;
};

Ledger.prototype.getProjects = function (
  this: Ledger,
  status?: string
): (ActiveProject & {tampered?: boolean})[] {
  // All project fields are encrypted — fetch all and filter in memory
  const rows = this.db
    .prepare("SELECT * FROM active_projects ORDER BY last_touched DESC")
    .all() as any[];

  const projects = rows.map((row: any) => {
    let tampered = false;

    const nameRes = this.safeDecryptGlobal(row.name || "", '', 'project_name');
    tampered ||= nameRes.tampered;
    const domainRes = this.safeDecryptGlobal(row.domain || "", '', 'project_domain');
    tampered ||= domainRes.tampered;
    const statusRes = this.safeDecryptGlobal(row.status || "active", 'active', 'project_status');
    tampered ||= statusRes.tampered;
    const summaryRes = this.safeDecryptGlobal(row.summary || "", '', 'project_summary');
    tampered ||= summaryRes.tampered;

    const result: ActiveProject & {tampered?: boolean} = {
      project_id: row.project_id,
      name: nameRes.value,
      domain: domainRes.value,
      status: statusRes.value as ActiveProject["status"],
      last_touched: row.last_touched,
      summary: summaryRes.value,
    };

    if (tampered) result.tampered = true;

    return result;
  });

  if (status) {
    return projects.filter((p) => p.status === status);
  }
  return projects;
};

Ledger.prototype.upsertProject = function (
  this: Ledger,
  project: ActiveProject
): void {
  this.db
    .prepare(
      `INSERT INTO active_projects (project_id, name, domain, status, last_touched, summary)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        domain = excluded.domain,
        status = excluded.status,
        last_touched = excluded.last_touched,
        summary = excluded.summary`
    )
    .run(
      project.project_id,
      this.encryptGlobal(project.name),
      this.encryptGlobal(project.domain),
      this.encryptGlobal(project.status),
      project.last_touched || new Date().toISOString(),
      this.encryptGlobal(project.summary)
    );
  this.logAudit("upsert_project", undefined, [project.project_id]);
};

Ledger.prototype.getDomainContext = function (
  this: Ledger,
  domains?: string[]
): Record<string, Record<string, unknown>> {
  let rows: any[];
  if (domains && domains.length > 0) {
    const pseudonyms = domains.map((d) => this.domainPseudonym(d));
    const placeholders = pseudonyms.map(() => "?").join(", ");
    rows = this.db
      .prepare(
        `SELECT * FROM domain_context WHERE domain IN (${placeholders})`
      )
      .all(...pseudonyms) as any[];
  } else {
    rows = this.db.prepare("SELECT * FROM domain_context").all() as any[];
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const realDomain = this.resolveDomain(row.domain);
    const res = this.safeDecryptForDomain(row.context || "{}", realDomain, "{}", `domain_context_${realDomain}`);
    result[realDomain] = safeJsonParse(res.value, {});
    // if (res.tampered) { /* flag if needed */ }
  }
  return result;
};

Ledger.prototype.getDomainContextVersion = function (
  this: Ledger,
  domain: string
): number {
  const pseudo = this.domainPseudonym(domain);
  const row = this.db
    .prepare("SELECT version FROM domain_context WHERE domain = ?")
    .get(pseudo) as { version: number } | undefined;
  return row?.version ?? 0; // 0 = domain context doesn't exist yet
};

Ledger.prototype.upsertDomainContext = function (
  this: Ledger,
  domain: string,
  context: Record<string, unknown>,
  expectedVersion?: number
): number {
  const pseudo = this.ensureDomainMapping(domain);
  const currentVersion = this.getDomainContextVersion(domain);
  this.checkExpectedVersion("domain_context", currentVersion, expectedVersion, domain);
  const existing = this.getDomainContext([domain]);
  const merged = { ...(existing[domain] || {}), ...context };
  const encrypted = this.encryptForDomain(JSON.stringify(merged), domain);
  const newVersion = currentVersion + 1;
  this.db
    .prepare(
      `INSERT INTO domain_context (domain, context, version, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        context = excluded.context,
        version = excluded.version,
        updated_at = excluded.updated_at`
    )
    .run(pseudo, encrypted, newVersion);
  this.logAudit("update_domain_context", pseudo);
  return newVersion;
};

Ledger.prototype.getState = function (
  this: Ledger,
  scopes: Scope[]
): UserState {
  const state: UserState = {};

  for (const scope of scopes) {
    switch (scope) {
      case "core_identity":
        state.core_identity = this.getIdentity();
        break;
      case "global_preferences":
        state.global_preferences = this.getPreferences();
        break;
      case "recent_timeline":
        state.recent_timeline = this.getTimeline({ last_n: 50 });
        break;
      case "domain_context":
        state.domain_context = this.getDomainContext();
        break;
      case "active_projects":
        state.active_projects = this.getProjects("active");
        break;
    }
  }

  this.logAudit(
    "get_state",
    scopes,
    undefined,
    undefined,
    JSON.stringify(state).length
  );
  return state;
};
