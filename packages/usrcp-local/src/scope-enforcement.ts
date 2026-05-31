/**
 * Shared scope-enforcement wrapper for MCP tool servers.
 *
 * Before this module existed, usrcp-local and usrcp-stream each had
 * their own copy of the scope-enforcement logic. The duplication
 * cost four rounds of codex review on PR #61 - each round caught a
 * different bypass in the same shape on the second copy. Chad
 * flagged the structural smell in his PR #62 review: "next adapter
 * that ships scope-aware MCP tools will hit the same trap otherwise."
 * Lift the wrapper into a single shared place, import it from both
 * packages, and the bypass class becomes a one-place change.
 *
 * The contract:
 *
 *   - `ServeOptions` describes the operator's intent: legacy
 *     `scopes` (symmetric) OR the asymmetric pair
 *     (`readScopes` / `writeScopes`), plus `readonly`/`noAudit`/`agentId`.
 *   - `resolveScopes` normalizes those into `readScopes` /
 *     `writeScopes` arrays with the documented precedence and
 *     edge-case semantics.
 *   - `registerToolsWithScopes` applies the wrapper at registration
 *     time: it strips mutating tools when writes are denied, strips
 *     audit-read tools when noAudit is set, and wraps every
 *     remaining tool's handler with the per-call scope check.
 *
 * The shared module deliberately doesn't depend on the full Ledger
 * class - it accepts a minimal `AuditSink` (only `logAudit` needed).
 * This keeps usrcp-stream's import surface tight and reflects what
 * the wrapper actually uses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

export interface ServeOptions {
  /**
   * Legacy symmetric domain allowlist. Sets BOTH `readScopes` and
   * `writeScopes` to the same value. Empty array is treated as
   * unrestricted. Mutually exclusive with `readScopes` /
   * `writeScopes` (caller must not mix them).
   */
  scopes?: string[];
  /**
   * Domains the agent is allowed to READ from. Undefined =
   * unrestricted. Empty array normalizes to undefined.
   *
   * When set alone (without `writeScopes` or legacy `scopes`),
   * defaults `writeScopes` to `[]` (no writes anywhere) -
   * "`--read-scopes X` is a read-only-on-X shorthand."
   */
  readScopes?: string[];
  /**
   * Domains the agent is allowed to WRITE to. Undefined =
   * unrestricted. Empty array `[]` means "no writes anywhere"
   * (equivalent to `readonly: true`). When both `readScopes`
   * and `writeScopes` are non-empty allowlists, writeScopes
   * MUST be a subset of readScopes.
   */
  writeScopes?: string[];
  /** Strip mutating tools entirely. Equivalent to `writeScopes: []`. */
  readonly?: boolean;
  /** Hide the audit-log tool so agents can't read other agents' history. */
  noAudit?: boolean;
  /** Identifier logged with every tool call. Required when any scope flag is set. */
  agentId?: string;
}

export interface ResolvedScopes {
  /** undefined = unrestricted reads; otherwise an allowlist. */
  readScopes: string[] | undefined;
  /**
   * undefined = unrestricted writes; non-empty array = write
   * allowlist; empty array = no writes anywhere (strips mutating
   * tools at register time).
   */
  writeScopes: string[] | undefined;
}

/**
 * Tool classification used by the wrapper:
 *
 *   global-read       always allowed regardless of scopes
 *   global-mutation   refused outright when writeScopes is set
 *                     (touches state shared across all domains)
 *   audit-read        readonly but suppressed by --no-audit
 *   domain-scoped     scopeOf(params) MUST be a subset of the
 *                     effective allowlist (writeScopes for
 *                     mutating tools, readScopes for reads)
 *   multi-domain-read reads across many domains; handler is
 *                     responsible for self-filtering when scopeOf
 *                     returns "all"
 */
export type ToolKind =
  | "global-read"
  | "global-mutation"
  | "audit-read"
  | "domain-scoped"
  | "multi-domain-read";

export interface ScopedToolDef {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  handler: (params: any) => Promise<any>;
  mutating?: boolean;
  kind: ToolKind;
  /**
   * Returns the domain(s) the call would touch. For multi-domain-read,
   * may return the literal `"all"` if the call is unconstrained. The
   * wrapper rejects an explicit out-of-scope filter at the INPUT layer;
   * the `"all"` (unconstrained) case is redacted at the OUTPUT layer by
   * `readProjection` (see below) rather than trusting the handler to
   * self-filter.
   */
  scopeOf?: (params: any) => string[] | "all";
  /**
   * Central, authoritative output redaction for cross-domain READ tools.
   *
   * When a tool can surface data spanning multiple domains (kind
   * `multi-domain-read` or `global-read`), it returns its result as a
   * plain payload object and declares this projection. The wrapper then:
   *
   *   - serializes the payload into the MCP text envelope (always), and
   *   - applies `readProjection(payload, readScopes)` first whenever the
   *     server is read-scoped, so out-of-scope facets are stripped in ONE
   *     enforced place instead of inside each handler.
   *
   * This inverts the pre-v0.1.8 contract. Previously each multi-domain
   * read hand-rolled its filtering inside its handler closure; forgetting
   * a facet was a silent cross-domain leak (the v0.1.3 globals leak and
   * the v0.1.4 audit-log leak were both this class). Now a cross-domain
   * read tool MUST declare a projection — `registerToolsWithScopes`
   * refuses to register one that doesn't when reads are scoped (fail
   * closed), so the omission surfaces as a loud, test-caught registration
   * error rather than a leak.
   *
   * A tool that declares `readProjection` returns a raw payload object;
   * a tool that does not returns a fully-formed MCP envelope.
   */
  readProjection?: (payload: any, readScopes: string[]) => any;
}

/**
 * Minimal interface for the wrapper's audit dependency. usrcp-local
 * passes a `Ledger`; usrcp-stream passes a `Ledger | null` (sync
 * tools don't always have one). Using a structural interface keeps
 * this module from importing the full Ledger class.
 *
 * Shape matches `Ledger.logAudit` exactly; the wrapper passes
 * `undefined` for the unused `eventIds`/`detail`/`responseSize`
 * arguments.
 */
export interface AuditSink {
  logAudit(
    operation: string,
    scopesAccessed?: string | string[],
    eventIds?: string[],
    detail?: string,
    responseSize?: number,
    agentId?: string,
  ): void;
}

/**
 * Resolve the four scope-related ServeOptions into the two effective
 * arrays used by the wrapper. The legacy `scopes` flag is an alias
 * for "both readScopes and writeScopes equal to scopes"; the
 * asymmetric flags can be combined for split permissions.
 *
 * Throws when the inputs are mutually inconsistent (writeScopes
 * has a domain not in readScopes; legacy `scopes` combined with
 * either asymmetric flag).
 *
 * Edge cases - locked in by codex rounds 1-5 on PRs #61 and #62:
 *
 *   - Legacy `scopes: []` normalizes to "unrestricted both ways"
 *     (pre-asymmetric semantics). Explicit `writeScopes: []` keeps
 *     the "no writes" sentinel.
 *   - `readScopes` alone (without writeScopes or legacy scopes)
 *     defaults writeScopes to []. "Read-only on X" shorthand.
 *   - `readonly: true` always wins, overriding any writeScopes.
 *   - Empty readScopes normalizes to undefined; empty writeScopes
 *     does NOT (it's the dedicated "no writes" sentinel).
 */
export function resolveScopes(opts: ServeOptions): ResolvedScopes {
  if (
    opts.scopes !== undefined &&
    (opts.readScopes !== undefined || opts.writeScopes !== undefined)
  ) {
    throw new Error(
      "--scopes is mutually exclusive with --read-scopes / --write-scopes. " +
        "Use --scopes alone (symmetric) OR the asymmetric pair.",
    );
  }

  // Legacy --scopes empty array historically meant "unrestricted
  // both ways"; preserve that. Explicit writeScopes: [] keeps the
  // "no writes" sentinel.
  const legacyScopes =
    opts.scopes !== undefined && opts.scopes.length > 0 ? opts.scopes : undefined;

  let readScopes: string[] | undefined = opts.readScopes;
  let writeScopes: string[] | undefined = opts.writeScopes;

  if (legacyScopes !== undefined) {
    readScopes = legacyScopes;
    writeScopes = legacyScopes;
  }

  // --read-scopes alone => "no writes" default.
  if (
    opts.readScopes !== undefined &&
    opts.writeScopes === undefined &&
    opts.scopes === undefined
  ) {
    writeScopes = [];
  }

  // --readonly always wins on writes.
  if (opts.readonly === true) {
    writeScopes = [];
  }

  // Empty-array normalization for reads (empty CSV must NOT lock
  // the operator out). Writes use [] as the dedicated sentinel.
  if (readScopes !== undefined && readScopes.length === 0) {
    readScopes = undefined;
  }

  // writeScopes ⊆ readScopes when both are restrictive. Empty
  // writeScopes (the "no writes" sentinel) is trivially a subset.
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

/**
 * Format the OUT_OF_SCOPE response envelope. Both packages emit
 * this exact shape so agent-side parsers stay uniform across the
 * local + stream tool surfaces.
 */
export function outOfScopeResponse(
  toolName: string,
  requested: string[],
  allowed: string[],
) {
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
              `Re-launch with broader --scopes or call from an unscoped server.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Serialize a raw payload object into the MCP text-content envelope.
 *
 * Read tools that declare a `readProjection` return their payload as a
 * plain object; the wrapper projects it (when scoped) then serializes it
 * here. Centralizing serialization keeps every projected read tool's
 * envelope shape identical to the hand-written `JSON.stringify(..., 2)`
 * envelopes the handlers used to build inline.
 */
export function toTextResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Keep only events whose resolved (plaintext) domain is in the read
 * allowlist. Events without a resolved domain are dropped — fail closed:
 * an event we can't attribute to an allowed domain must not be returned
 * to a scoped reader.
 */
export function filterEventsToScopes<T extends { domain?: string }>(
  events: T[] | undefined,
  readScopes: string[],
): T[] {
  if (!Array.isArray(events)) return [];
  const allowed = new Set(readScopes);
  return events.filter(
    (e) => typeof e?.domain === "string" && allowed.has(e.domain),
  );
}

/**
 * Authoritative read-projection for `usrcp_get_state`. A scoped agent must
 * never receive (a) the global facets `core_identity` / `global_preferences`
 * or (b) per-domain facets (active_projects, domain_context, recent_timeline)
 * for domains outside its read allowlist.
 *
 * Mutates and returns `payload` for caller convenience (the wrapper hands
 * it a fresh per-call object). See {@link ScopedToolDef.readProjection}
 * for why this lives here rather than in the handler.
 */
export function projectStateResult(payload: any, readScopes: string[]): any {
  const state = payload?.state;
  if (!state || typeof state !== "object") return payload;
  const allowed = new Set(readScopes);

  // Globals are owner-only in scoped mode (v0.1.3 leak class).
  delete state.core_identity;
  delete state.global_preferences;

  if (Array.isArray(state.active_projects)) {
    state.active_projects = state.active_projects.filter((p: any) =>
      allowed.has(p?.domain),
    );
  }
  if (state.domain_context && typeof state.domain_context === "object") {
    state.domain_context = Object.fromEntries(
      Object.entries(state.domain_context).filter(([d]) => allowed.has(d)),
    );
  }
  if (Array.isArray(state.recent_timeline)) {
    state.recent_timeline = filterEventsToScopes(state.recent_timeline, readScopes);
  }
  return payload;
}

/**
 * Authoritative read-projection for `usrcp_search_timeline`: drop any
 * result event outside the read allowlist and recompute the count so a
 * scoped caller can't infer out-of-scope hit volume from `result_count`.
 */
export function projectSearchResult(payload: any, readScopes: string[]): any {
  const events = filterEventsToScopes(payload?.events, readScopes);
  return { ...payload, result_count: events.length, events };
}

/**
 * Shape the scoped envelope for `usrcp_status`. Status reports aggregates
 * (counts, domain/platform lists) that cannot be reconstructed by
 * filtering an unscoped payload after the fact — `stats` and the project
 * count must be computed against the scope at query time. The caller
 * gathers those scoped figures (it has the ledger) and passes them here;
 * this builder owns the envelope SHAPE so a scoped caller never receives
 * the unscoped `total_projects` / `db_size_bytes` / `audit_log_entries`
 * fields, only the scope-safe subset.
 */
export interface ScopedStatusInput {
  usrcp_version: string;
  user_id: string;
  /** Result of `Ledger.getStatsForScopes(readScopes)`. */
  stats: unknown;
  /** Count of active projects whose domain is in the read allowlist. */
  active_projects: number;
  allowed_domains: string[];
}
export function buildScopedStatusPayload(input: ScopedStatusInput) {
  return {
    usrcp_version: input.usrcp_version,
    user_id: input.user_id,
    ledger: "local (SQLite)",
    scoped: true,
    allowed_domains: input.allowed_domains,
    stats: input.stats,
    active_projects: input.active_projects,
  };
}

/** Compact display string for the audit row. */
function formatScopeArr(s: string[] | undefined): string {
  return s === undefined ? "*" : s.length === 0 ? "[]" : `[${s.join(",")}]`;
}

export interface AuditFailureContext {
  toolName: string;
  agentId: string;
  scopeRepr: string;
}

export interface RegisterToolsOptions {
  /**
   * When true (the usrcp-local default), an audit-row write
   * failure throws out of the wrapper before the handler runs,
   * so a scoped tool call cannot proceed without attribution.
   *
   * When false (the usrcp-stream default), audit failures are
   * swallowed and the handler runs anyway - "best-effort"
   * sibling-package logging. The trade-off is documented at
   * each call site; codex round-1 review on PR #64 flagged
   * that mixing the two without a flag let stream's leniency
   * leak into local.
   *
   * Default: true (strict). Stream passes false explicitly.
   */
  strictAudit?: boolean;

  /**
   * Enforce the v0.1.8 default-deny read-projection invariant: when reads
   * are scoped, every cross-domain read tool (multi-domain-read /
   * global-read) MUST declare a `readProjection` or registration throws.
   *
   * Default: true. usrcp-local and usrcp-stream both rely on the default:
   * query-time filtering may remain for efficiency, but every cross-domain
   * read declares a final output projection and a future tool that forgets
   * one fails closed.
   */
  enforceReadProjection?: boolean;

  /**
   * Invoked when `strictAudit: false` swallows a logAudit failure.
   * Closes Codex Tier-2 #4: pre-this-PR the catch block silently
   * dropped the error so a scoped stream call could proceed with
   * NO forensic record that it ran unaudited. Now the failure goes
   * to this callback (or to console.warn by default) so an operator
   * grepping logs can correlate a missing audit row to the tool
   * call that produced it.
   *
   * Strict mode (default) ignores this callback entirely - audit
   * failures throw out of the wrapper, the handler never runs,
   * there's nothing to surface beyond the thrown error itself.
   *
   * Default: a console.warn with the tool name, agent id, scope
   * repr, and error message.
   */
  onAuditFailure?: (err: unknown, ctx: AuditFailureContext) => void;
}

function defaultOnAuditFailure(err: unknown, ctx: AuditFailureContext): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[usrcp] best-effort audit failed for tool=${ctx.toolName} agent=${ctx.agentId} scope=${ctx.scopeRepr}: ${msg}. ` +
      `The tool call proceeded unaudited (strictAudit:false); a row should have been written to audit_log but was not.`
  );
}

/**
 * Register a list of tool definitions on the given MCP server,
 * applying scope-enforcement at both registration time
 * (filter mutating + audit-read tools) and per-call (the wrapper
 * handler).
 *
 * Both usrcp-local and usrcp-stream call this function with their
 * own tool tables. The semantics are identical across packages -
 * that's the whole point of having one shared implementation. The
 * one knob is `strictAudit`: usrcp-local fails closed on audit
 * write failure (audit is a security property in scoped mode);
 * usrcp-stream falls back to best-effort to keep cross-package
 * audit failures from cratering stream tools.
 */
export function registerToolsWithScopes(
  server: McpServer,
  defs: ScopedToolDef[],
  opts: ServeOptions,
  ledger: AuditSink | null,
  registerOpts: RegisterToolsOptions = {},
): void {
  const { readScopes, writeScopes } = resolveScopes(opts);

  // Default-deny registration invariant (v0.1.8). A read tool that can
  // surface data spanning multiple domains (multi-domain-read or
  // global-read) MUST declare a `readProjection` so the wrapper can
  // redact its output to the read allowlist in one enforced place. With
  // no projection the wrapper has no way to scrub cross-domain output, so
  // we refuse to register the tool rather than let it leak. This converts
  // "new read tool forgot to self-filter" (the v0.1.3 globals leak and the
  // v0.1.4 audit-log leak were both this shape) from a silent bypass into
  // a loud error caught by the first scoped test. Only enforced when reads
  // are actually scoped — an unscoped server returns everything to its
  // owner and has nothing to project. Defaults on; usrcp-stream opts out
  // (it uses scope-wall injection — see RegisterToolsOptions).
  const enforceReadProjection = registerOpts.enforceReadProjection ?? true;
  if (enforceReadProjection && readScopes !== undefined) {
    for (const def of defs) {
      const crossDomainRead =
        !def.mutating &&
        (def.kind === "multi-domain-read" || def.kind === "global-read");
      if (crossDomainRead && typeof def.readProjection !== "function") {
        throw new Error(
          `scope-enforcement: read tool '${def.name}' (kind=${def.kind}) is ` +
            `registered under a read scope but declares no readProjection. ` +
            `Cross-domain read tools must declare a projection so their ` +
            `output can be redacted to the read allowlist. Refusing to ` +
            `register a tool that could leak out-of-scope data.`,
        );
      }
    }
  }

  // A mutating tool is stripped entirely (not registered) when
  // writes are disallowed across all domains - i.e.
  // `writeScopes === []`, which is either `--readonly` or
  // explicit `--write-scopes=`. With writeScopes undefined
  // (unrestricted) or a non-empty array, the tool registers and
  // the wrapper gates per-domain.
  const writesAllDenied = writeScopes !== undefined && writeScopes.length === 0;

  // Wrapper-layer audit fires only when the operator has explicitly
  // opted into scoped mode (any flag set). The unflagged default
  // path keeps the pre-refactor audit-row volume so existing
  // single-agent setups don't see a behavior change.
  const scopedMode =
    readScopes !== undefined ||
    writeScopes !== undefined ||
    opts.noAudit === true ||
    opts.agentId !== undefined;
  const agentId = opts.agentId ?? "unidentified";
  const auditScopeRepr = `read=${formatScopeArr(readScopes)};write=${formatScopeArr(writeScopes)}`;
  const strictAudit = registerOpts.strictAudit ?? true;
  const onAuditFailure = registerOpts.onAuditFailure ?? defaultOnAuditFailure;

  for (const def of defs) {
    // Registration-time filtering: tools that the caller has
    // opted out of are not registered at all, so they do not
    // appear in tools/list.
    if (writesAllDenied && def.mutating) continue;
    if (opts.noAudit && def.kind === "audit-read") continue;

    // SECURITY (v0.1.4): audit-read is owner-only by design. Strip it
    // from any READ-scoped session — a `--read-scopes=coding` agent
    // shouldn't be able to enumerate operations on `personal`,
    // ULIDs from other domains, scope-pseudonym mappings, or the
    // existence of other agents. v0.1.3 only stripped audit-read
    // when --no-audit was explicitly passed; that defaulted any
    // scoped session into the leak path.
    //
    // Gating on readScopes !== undefined specifically (rather than
    // "any scope flag") preserves audit visibility for `--readonly`
    // sessions (read everything but write nothing — owner-equivalent
    // for reads) and `--write-scopes=X` alone (reads unrestricted,
    // writes limited).
    if (def.kind === "audit-read" && readScopes !== undefined) {
      continue;
    }

    const wrappedHandler = async (params: any) => {
      if (scopedMode && ledger) {
        // Strict (usrcp-local default): an audit-row failure
        // throws out of the wrapper, failing the tool call
        // closed before any read or mutation happens. The
        // scoped-mode contract is "per-call attribution
        // guaranteed"; an unattributed proceed would silently
        // violate it.
        //
        // Best-effort (usrcp-stream opt-in): swallow audit
        // failures so a stream tool can still respond when the
        // sibling-package ledger pipeline hiccups. Trade-off
        // documented in stream's register.ts call site.
        if (strictAudit) {
          ledger.logAudit(
            `mcp_call:${def.name}`,
            auditScopeRepr,
            undefined,
            undefined,
            undefined,
            agentId,
          );
        } else {
          try {
            ledger.logAudit(
              `mcp_call:${def.name}`,
              auditScopeRepr,
              undefined,
              undefined,
              undefined,
              agentId,
            );
          } catch (err) {
            // Best-effort: see RegisterToolsOptions.strictAudit.
            // Pre-Codex-Tier-2-#4 this was a bare swallow; now we
            // route through onAuditFailure (console.warn by default)
            // so the missing audit row leaves at least a stderr
            // breadcrumb the operator can grep for.
            try {
              onAuditFailure(err, {
                toolName: def.name,
                agentId,
                scopeRepr: auditScopeRepr,
              });
            } catch {
              // A callback that itself throws must not break the
              // tool call - that would defeat the whole point of
              // strictAudit:false.
            }
          }
        }
      }

      // Mutating tools check writeScopes; read tools check
      // readScopes. Distinguishing the two is what enables
      // asymmetric permissions ("read everything, write only
      // {personal}").
      const effective = def.mutating ? writeScopes : readScopes;

      if (effective) {
        if (def.kind === "global-mutation") {
          // Any restricted writeScopes (even non-empty) bars
          // global mutations - they touch state shared across
          // every domain.
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
              (d) => !effective.includes(d),
            );
            if (out.length > 0) {
              return outOfScopeResponse(def.name, out, effective);
            }
          }
          // If "all" (unconstrained), the wrapper does NOT reject at the
          // input layer — instead the OUTPUT is redacted centrally by
          // `def.readProjection` below. The registration invariant
          // guarantees a multi-domain-read tool has one.
        }
      }

      const result = await def.handler(params);

      // Central read-projection. A tool that declares `readProjection`
      // returns a raw payload object; serialize it here (and redact to
      // the read allowlist first whenever the server is read-scoped).
      // This is the single enforced chokepoint for cross-domain read
      // redaction — handlers no longer self-filter. Tools without a
      // projection (mutations, domain-scoped reads gated at the input
      // layer above, audit-read) return a fully-formed envelope as before.
      if (def.readProjection) {
        const projected =
          readScopes !== undefined
            ? def.readProjection(result, readScopes)
            : result;
        return toTextResult(projected);
      }

      return result;
    };

    server.tool(def.name, def.description, def.inputShape, wrappedHandler);
  }
}
