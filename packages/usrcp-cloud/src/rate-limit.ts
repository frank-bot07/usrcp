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
  /**
   * Number of trusted proxies appending to X-Forwarded-For in front of this
   * process. The client IP is taken that many entries from the RIGHT of the
   * chain: everything further left is client-controlled and must never be
   * trusted, or a scanner rotates the leftmost entry and gets a fresh
   * rate-limit bucket per request (#177).
   */
  trustProxyHops: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  signedRpmDefault: 600,             // 10 req/sec per IP across signed routes
  pairingClaimRpm: 30,               // ~0.5 req/sec - much stricter
  pairingInitRpm: 10,                // ~1 init per 6s
  windowMs: 60_000,                  // 1 minute
  pairingDistinctCodesPerWindow: 20, // 20 distinct codes in probeWindowMs => block
  probeWindowMs: 10 * 60_000,        // 10 min (matches pairing TTL)
  trustProxy: false,
  trustProxyHops: 1,
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
    // TRUST_PROXY=1 or true enables XFF with one trusted hop; TRUST_PROXY=<n>
    // (n >= 2) declares a chain of n trusted proxies. Anything else disables
    // XFF and attributes by TCP peer.
    trustProxy:
      env["TRUST_PROXY"]?.toLowerCase() === "true" ||
      (Number.isInteger(Number(env["TRUST_PROXY"])) && Number(env["TRUST_PROXY"]) >= 1),
    trustProxyHops:
      Number.isInteger(Number(env["TRUST_PROXY"])) && Number(env["TRUST_PROXY"]) >= 1
        ? Number(env["TRUST_PROXY"])
        : 1,
  };
}

/**
 * Sliding-window counter: each bucket holds the timestamps of all
 * requests within `windowMs`, capped at `hardCap` entries so a
 * sustained flood from one IP cannot grow the array unboundedly
 * during the window. Once an IP has reached the cap (which is one
 * past the per-route limit), subsequent hit() calls return the
 * saturated size without appending - the caller still sees
 * `size > limit` and 429s, and the bucket's CPU + memory cost stays
 * bounded.
 *
 * Per request: O(W) walk for expired-entry pruning where W = hardCap;
 * with the defaults that is ~601 entries for the signed counter,
 * trivial.
 */
class SlidingCounter {
  private readonly buckets = new Map<string, number[]>();

  hit(key: string, now: number, windowMs: number, hardCap: number): number {
    const arr = this.buckets.get(key) ?? [];
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    const live = i === 0 ? arr : arr.slice(i);
    if (live.length < hardCap) {
      live.push(now);
    }
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
 *
 * To bound memory under attack, observe() refuses to grow the per-IP
 * set past `hardCap` entries; once a scanner has tripped the
 * threshold, subsequent requests still return `hardCap` (so the
 * caller keeps returning 429 PROBE_DETECTED) but the map stops
 * accumulating new codes.
 */
class DistinctProbeTracker {
  private readonly buckets = new Map<string, Map<string, number>>();

  observe(key: string, distinctValue: string, now: number, windowMs: number, hardCap: number): number {
    const cutoff = now - windowMs;
    const m = this.buckets.get(key) ?? new Map<string, number>();
    for (const [v, ts] of m) if (ts < cutoff) m.delete(v);
    if (m.size < hardCap) {
      if (!m.has(distinctValue)) m.set(distinctValue, now);
    }
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
function clientIp(req: FastifyRequest, trustProxy: boolean, trustProxyHops: number): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      // X-Forwarded-For is client-controlled except for the entries appended
      // by our own trusted proxies, which are the RIGHTMOST ones. With N
      // trusted proxies, the real client IP is the Nth entry from the right;
      // taking the leftmost let a scanner rotate a fake "client" per request
      // and bypass every per-IP limit (#177, reproduced 0/50 blocked).
      const entries = xff.split(",").map((e) => e.trim()).filter(Boolean);
      const hops = Math.max(1, Math.floor(trustProxyHops));
      const candidate = entries[entries.length - hops];
      if (candidate) return candidate;
      // Chain shorter than the declared trusted-hop count: the request did
      // not traverse our proxy tier as configured. Fall back to the TCP peer
      // rather than trusting any client-supplied entry.
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
 *
 * The hook is wired as `onRequest` (the earliest lifecycle stage) so
 * blocked clients receive 429 BEFORE their POST body is buffered or
 * JSON-parsed. preParsing / preValidation / preHandler all run later
 * in the pipeline; putting the limiter at onRequest stops a
 * sustained POST flood from doing the 2 MiB body-buffer + JSON.parse
 * work just to be rejected.
 */
export function registerRateLimits(app: FastifyInstance, state: RateLimitState): void {
  const { config } = state;

  app.addHook("onRequest", async (req, reply) => {
    const ip = clientIp(req, config.trustProxy, config.trustProxyHops);
    const url = req.routeOptions?.url ?? req.url;
    const method = req.method.toUpperCase();
    const now = Date.now();

    // /healthz is exempt - it's a liveness probe that must always answer.
    if (url === "/healthz") return;

    // Per-route stricter limits.
    if (method === "GET" && url === "/v1/pairing/claim/:code") {
      // 1) Per-IP request-rate cap on the claim endpoint first. This
      //    bounds how fast an attacker can grow the probe map below,
      //    so even the worst-case scanner can only add
      //    pairingClaimRpm entries per windowMs into the probe set.
      //    The hardCap is the per-route limit + 1 so the array stays
      //    bounded under a sustained flood.
      const hits = state.claim.hit(ip, now, config.windowMs, config.pairingClaimRpm + 1);
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

      // 2) Distinct-code probe detector. The map is capped at
      //    pairingDistinctCodesPerWindow + 1 (one past the threshold)
      //    so an IP that has tripped the detector cannot grow the
      //    map further. Beyond the cap, observe() still returns the
      //    saturated size so `> threshold` keeps firing.
      const codeParam = (req.params as { code?: string }).code ?? "";
      const hardCap = config.pairingDistinctCodesPerWindow + 1;
      const distinct = state.probe.observe(ip, codeParam, now, config.probeWindowMs, hardCap);
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
      return;
    }

    if (method === "POST" && url === "/v1/pairing/init") {
      const hits = state.init.hit(ip, now, config.windowMs, config.pairingInitRpm + 1);
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
    const hits = state.signed.hit(ip, now, config.windowMs, config.signedRpmDefault + 1);
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
