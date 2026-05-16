/**
 * In-process per-IP rate limiting + brute-force detection.
 *
 * The cloud's most attractive target is GET /v1/pairing/claim/:code -
 * it's the only authenticated-data endpoint that does NOT require an
 * Ed25519 signature, by design (device B has no identity yet). The
 * 5-attempts-per-code cap already in pairing.ts blocks per-code
 * brute force, but a patient attacker can still scan distinct codes
 * across the 1e8 codespace from many IPs. This module adds:
 *
 *   1. A general sliding-window per-IP request limit per route group.
 *   2. A "distinct codes per IP" detector specifically for the pairing
 *      claim endpoint, which is what catches the cross-code scanner.
 *
 * Everything is in-process memory keyed by IP. Production deployments
 * with multiple cloud instances should put a reverse proxy with its
 * own rate limiter in front (this layer remains useful as defense in
 * depth and zero-config out-of-the-box).
 *
 * Pruning rides the same setInterval that cleans nonces +
 * pairing_bundles - see packages/usrcp-cloud/src/index.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitConfig {
  /** Default limit (requests per windowMs) for any signed request. */
  signedRpmDefault: number;
  /** Stricter limit for the unauthenticated pairing claim endpoint. */
  pairingClaimRpm: number;
  /** Limit for POST /v1/pairing/init (signed but worth bounding). */
  pairingInitRpm: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max DISTINCT pairing codes a single IP may probe per probeWindowMs. */
  pairingDistinctCodesPerWindow: number;
  probeWindowMs: number;
  /** Honor X-Forwarded-For for IP attribution (only set behind a trusted proxy). */
  trustProxy: boolean;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  signedRpmDefault: 600,             // 10 req/sec per IP across signed routes
  pairingClaimRpm: 30,               // ~0.5 req/sec - much stricter
  pairingInitRpm: 10,                // ~1 init per 6s
  windowMs: 60_000,                  // 1 minute
  pairingDistinctCodesPerWindow: 20, // 20 distinct codes in probeWindowMs => block
  probeWindowMs: 10 * 60_000,        // 10 min (matches pairing TTL)
  trustProxy: false,
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const num = (name: string, fallback: number) => {
    const v = env[name];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    signedRpmDefault: num("RATE_LIMIT_SIGNED_RPM", DEFAULT_RATE_LIMIT_CONFIG.signedRpmDefault),
    pairingClaimRpm: num("RATE_LIMIT_PAIRING_CLAIM_RPM", DEFAULT_RATE_LIMIT_CONFIG.pairingClaimRpm),
    pairingInitRpm: num("RATE_LIMIT_PAIRING_INIT_RPM", DEFAULT_RATE_LIMIT_CONFIG.pairingInitRpm),
    windowMs: num("RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT_CONFIG.windowMs),
    pairingDistinctCodesPerWindow: num("RATE_LIMIT_PROBE_CODES", DEFAULT_RATE_LIMIT_CONFIG.pairingDistinctCodesPerWindow),
    probeWindowMs: num("RATE_LIMIT_PROBE_WINDOW_MS", DEFAULT_RATE_LIMIT_CONFIG.probeWindowMs),
    trustProxy: env["TRUST_PROXY"] === "1" || env["TRUST_PROXY"]?.toLowerCase() === "true",
  };
}

/**
 * Sliding-window counter: each bucket holds the timestamps of all
 * requests within `windowMs`. On every hit we drop expired entries
 * and compare the remaining size against the limit.
 *
 * For high-cardinality keys (one bucket per IP) this is O(W) per
 * request where W = limit; with the defaults that is ~600 entries
 * per IP, trivial.
 */
class SlidingCounter {
  private readonly buckets = new Map<string, number[]>();

  hit(key: string, now: number, windowMs: number): number {
    const arr = this.buckets.get(key) ?? [];
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    const live = i === 0 ? arr : arr.slice(i);
    live.push(now);
    this.buckets.set(key, live);
    return live.length;
  }

  prune(now: number, windowMs: number): number {
    let removed = 0;
    const cutoff = now - windowMs;
    for (const [key, arr] of this.buckets.entries()) {
      let i = 0;
      while (i < arr.length && arr[i] < cutoff) i++;
      if (i === arr.length) {
        this.buckets.delete(key);
        removed += arr.length;
      } else if (i > 0) {
        this.buckets.set(key, arr.slice(i));
        removed += i;
      }
    }
    return removed;
  }

  /** Test helper. */
  size(): number {
    let n = 0;
    for (const arr of this.buckets.values()) n += arr.length;
    return n;
  }
}

/**
 * Distinct-set tracker: per IP, the set of pairing codes it has
 * probed within `probeWindowMs`. Each entry stores (code, firstSeenAt).
 */
class DistinctProbeTracker {
  private readonly buckets = new Map<string, Map<string, number>>();

  observe(key: string, distinctValue: string, now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    const m = this.buckets.get(key) ?? new Map<string, number>();
    for (const [v, ts] of m) if (ts < cutoff) m.delete(v);
    if (!m.has(distinctValue)) m.set(distinctValue, now);
    this.buckets.set(key, m);
    return m.size;
  }

  prune(now: number, windowMs: number): number {
    let removed = 0;
    const cutoff = now - windowMs;
    for (const [key, m] of this.buckets.entries()) {
      for (const [v, ts] of m) {
        if (ts < cutoff) { m.delete(v); removed++; }
      }
      if (m.size === 0) this.buckets.delete(key);
    }
    return removed;
  }

  size(): number {
    let n = 0;
    for (const m of this.buckets.values()) n += m.size;
    return n;
  }
}

export interface RateLimitState {
  config: RateLimitConfig;
  signed: SlidingCounter;
  claim: SlidingCounter;
  init: SlidingCounter;
  probe: DistinctProbeTracker;
}

export function createRateLimitState(config: RateLimitConfig): RateLimitState {
  return {
    config,
    signed: new SlidingCounter(),
    claim: new SlidingCounter(),
    init: new SlidingCounter(),
    probe: new DistinctProbeTracker(),
  };
}

export function pruneRateLimitState(state: RateLimitState, now: number = Date.now()): number {
  let total = 0;
  total += state.signed.prune(now, state.config.windowMs);
  total += state.claim.prune(now, state.config.windowMs);
  total += state.init.prune(now, state.config.windowMs);
  total += state.probe.prune(now, state.config.probeWindowMs);
  return total;
}

/**
 * Extract the client IP from the request, honoring X-Forwarded-For
 * only when TRUST_PROXY=1. Defaults to req.ip which Fastify pins to
 * the immediate TCP peer when trust-proxy is not configured at the
 * Fastify level.
 */
function clientIp(req: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      // X-Forwarded-For can be a comma-separated chain; the LEFTMOST
      // value is the original client per RFC 7239 / convention.
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.ip ?? "unknown";
}

function rejectRate(reply: FastifyReply, retryAfterSec: number, code: string, message: string): void {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
  reply.code(429).send({ error: code, message });
}

/**
 * Register the rate-limit hook + probe detector on a Fastify app.
 * Must run BEFORE the route handlers see the request. The hook is
 * a `preHandler` so it runs after URL parsing (we need the matched
 * route) but before the handler.
 */
export function registerRateLimits(app: FastifyInstance, state: RateLimitState): void {
  const { config } = state;

  app.addHook("preHandler", async (req, reply) => {
    const ip = clientIp(req, config.trustProxy);
    const url = req.routeOptions?.url ?? req.url;
    const method = req.method.toUpperCase();
    const now = Date.now();

    // /healthz is exempt - it's a liveness probe that must always answer.
    if (url === "/healthz") return;

    // Per-route stricter limits.
    if (method === "GET" && url === "/v1/pairing/claim/:code") {
      // Distinct-code probe detector: if this IP has hit too many
      // DIFFERENT codes recently, block before incrementing the
      // per-route counter so we don't waste counter slots on probes.
      const codeParam = (req.params as { code?: string }).code ?? "";
      const distinct = state.probe.observe(ip, codeParam, now, config.probeWindowMs);
      if (distinct > config.pairingDistinctCodesPerWindow) {
        app.log.warn(
          { ip, distinct, window_ms: config.probeWindowMs, route: url },
          "rate_limit_block_probe"
        );
        return rejectRate(
          reply,
          config.probeWindowMs / 1000,
          "PROBE_DETECTED",
          `Too many distinct pairing codes probed from this IP; try again later.`
        );
      }

      const hits = state.claim.hit(ip, now, config.windowMs);
      if (hits > config.pairingClaimRpm) {
        app.log.warn(
          { ip, hits, limit: config.pairingClaimRpm, route: url },
          "rate_limit_block_claim"
        );
        return rejectRate(
          reply,
          config.windowMs / 1000,
          "RATE_LIMITED",
          `Too many pairing claims from this IP.`
        );
      }
      return;
    }

    if (method === "POST" && url === "/v1/pairing/init") {
      const hits = state.init.hit(ip, now, config.windowMs);
      if (hits > config.pairingInitRpm) {
        app.log.warn(
          { ip, hits, limit: config.pairingInitRpm, route: url },
          "rate_limit_block_init"
        );
        return rejectRate(
          reply,
          config.windowMs / 1000,
          "RATE_LIMITED",
          `Too many pair-init requests from this IP.`
        );
      }
      return;
    }

    // Default per-IP limit for every other signed route. We bucket all
    // signed routes together rather than per-route so a single attacker
    // can't hammer multiple endpoints to exhaust each one independently.
    const hits = state.signed.hit(ip, now, config.windowMs);
    if (hits > config.signedRpmDefault) {
      app.log.warn(
        { ip, hits, limit: config.signedRpmDefault, route: url, method },
        "rate_limit_block_signed"
      );
      return rejectRate(
        reply,
        config.windowMs / 1000,
        "RATE_LIMITED",
        `Too many requests from this IP.`
      );
    }
  });
}

// Internal exports for tests.
export const _internal = { SlidingCounter, DistinctProbeTracker };
