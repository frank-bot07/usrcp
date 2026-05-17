# Task 14 - Cloud hardening (rate limiting + probe detection)

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/cloud-hardening` (lands after #48).

## Why this exists

After pairing + rotation shipped, the most attractive attack surface
on `usrcp-cloud` became `GET /v1/pairing/claim/:code` - the only
authenticated-data route that does NOT require an Ed25519 signature
(by design: device B has no identity yet, so we can't sign-gate the
endpoint).

The 5-attempts-per-code cap in `pairing.ts` blocks per-code brute
force. It does NOT block a patient cross-code scanner: with a 1e8
codespace and a 10-min TTL, an attacker probing 1000 distinct codes
per second covers the entire live set in minutes. The 5-attempts
cap would only get them to 5 attempts per code before each row
auto-prunes, but they can probe each row exactly once and let the
TTL/cap reset them.

This PR adds two complementary in-process defenses, both per-IP and
both zero-config out of the box:

1. **Sliding-window request rate limit** per IP per route group.
2. **Distinct-code probe detector**: per-IP set of distinct pairing
   codes seen via `claim` within a window. Trips before any one
   code's 5-attempts cap can.

## Scope decisions (2026-05-16)

| Topic | Choice | Reason |
|---|---|---|
| In-process vs Redis | In-process Map / sliding-window counter | Zero-config, no new dep. Defense-in-depth that a proxy-level limiter (Nginx/Cloudflare) should sit in front of in real prod. |
| Sliding window vs fixed window | Sliding (timestamps stored per IP, expired entries dropped on read) | Avoids the boundary-burst issue where an attacker times requests around fixed boundaries. |
| What counts as the "client IP" | `req.ip` by default; `X-Forwarded-For` honored only when `TRUST_PROXY=1` | XFF is trivially spoofable when no proxy is in front; the default must not trust it. |
| Per-route buckets | Yes, separate counters for `pairing/claim`, `pairing/init`, and "everything else signed" | Lets us be stricter on the unauthenticated route without throttling legitimate sync. |
| Distinct-code threshold | 20 codes per 10-min window per IP, default | Generous enough that a real cross-device pairing never trips it; tight enough that a scanner hits it before doing meaningful damage to the live set. |
| `/healthz` exempt | Yes | Liveness probes must always answer. |
| 429 envelope | `{ error: "RATE_LIMITED" \| "PROBE_DETECTED", message: "..." }` + `Retry-After` header | Distinct error codes so a confused client can tell why it was blocked. |

## Env configuration

| Env var | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_SIGNED_RPM` | `600` | Per-IP cap on signed endpoints (per `RATE_LIMIT_WINDOW_MS`). |
| `RATE_LIMIT_PAIRING_CLAIM_RPM` | `30` | Cap on `GET /v1/pairing/claim/:code`. |
| `RATE_LIMIT_PAIRING_INIT_RPM` | `10` | Cap on `POST /v1/pairing/init`. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window for the per-route limits. |
| `RATE_LIMIT_PROBE_CODES` | `20` | Max distinct codes one IP may probe via `claim`. |
| `RATE_LIMIT_PROBE_WINDOW_MS` | `600000` | Probe-detector window (10 min). |
| `TRUST_PROXY` | `0` | `1` / `true` to honor X-Forwarded-For for IP attribution. |

The defaults are conservative enough that none of the existing test
suites (cloud 64, local 399, stream 107) trip them.

## Threat model

What this protects against:

- **Cross-code scanner on the claim endpoint.** Catches the patient
  scanner that paces around the 5-attempts-per-code cap. Bound is
  `RATE_LIMIT_PROBE_CODES` distinct codes per `RATE_LIMIT_PROBE_WINDOW_MS`
  per IP; below that bound the legitimate pairing flow always fits.
- **Single-IP request flood.** Caps signed routes at 10 req/sec by
  default per IP; pairing claim at 0.5 req/sec; pairing init at
  ~1 req/6s.
- **CPU exhaustion on the Ed25519 signature verify.** The signed-RPM
  cap is the load-bearing one here; without it an attacker could
  flood the auth middleware with junk requests just to burn cycles.

What this does NOT protect against:

- **Distributed attacks.** The limiter is per-IP. A botnet with
  thousands of IPs can still cover the codespace below the per-IP
  thresholds. The right answer for that scale is a proxy-level
  reputational limiter (Cloudflare / WAF) in front of the cloud.
- **Slow-burn scanners under the threshold.** An attacker who paces
  themselves below 30 RPM AND below 20 distinct codes per 10 min
  per IP can still scan ~120 codes per IP per hour. Still requires
  ~24 IPs to cover a "lucky day's" worth of active codes in an
  hour. Combined with the 10-min TTL, this is impractical without
  a botnet.
- **Storage / DB DoS.** Body size is bounded at 2 MiB elsewhere;
  this PR doesn't change that.

## Operational notes

- Production with N cloud instances behind a load balancer: the
  in-process limiter is per-instance, so a coordinated attacker who
  hashes across instances effectively sees N × the per-instance
  threshold. A proxy-level limiter in front is the right add-on.
- Memory: each tracked IP holds at most `RATE_LIMIT_SIGNED_RPM` (600)
  request timestamps for signed routes, plus the probe distinct-set.
  An idle IP's entries are pruned by the same 5-minute setInterval
  that handles nonces + pairing bundles. Bounded growth.
- Logs: every block emits a structured log line at `warn` level with
  `ip`, `route`, `hits` / `distinct`, and the limit. Feed it into
  any log aggregator to drive alerting.
- The `rate_limit_block_probe` log line is the canonical signal that
  someone is scanning. Trip an oncall page on it.

## Surface area

**New:**
- `packages/usrcp-cloud/src/rate-limit.ts` - sliding-window counter,
  distinct-set tracker, env loader, Fastify preHandler hook, prune
  helper.
- `packages/usrcp-cloud/src/__tests__/rate-limit.test.ts` - 8 tests:
  env parsing, /healthz exemption, claim rpm cap, probe detector,
  signed default cap, X-Forwarded-For trust gating, disable knob.

**Modified:**
- `packages/usrcp-cloud/src/server.ts` - new `rateLimit?: RateLimitConfig | false`
  option on `ServerOptions`. When omitted, defaults are loaded from
  env. `false` bypasses entirely (used in tests that want to exercise
  per-route behavior without the limiter interfering).
- `packages/usrcp-cloud/src/index.ts` - prune loop also prunes the
  rate-limit state.
- `packages/usrcp-cloud/README.md` - rate-limit section + env table.

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)   # 72 tests (+8)
(cd packages/usrcp-local  && npm run build && npm test)   # 399 unchanged
(cd packages/usrcp-stream && npm run build && npm test)   # 107 unchanged
```

All three suites green. The new tests cover:

- Env config defaults + parsing of `RATE_LIMIT_*` and `TRUST_PROXY`.
- `/healthz` is never rate-limited.
- Claim-endpoint rpm cap blocks the (limit+1)th request and returns
  `RATE_LIMITED` + `Retry-After`.
- Distinct-code probe detector trips after `RATE_LIMIT_PROBE_CODES + 1`
  different codes, returning `PROBE_DETECTED`.
- Same-code repeats do NOT bump the distinct-set counter.
- Signed-default cap blocks the (limit+1)th `/v1/state` GET per IP.
- `X-Forwarded-For` is ignored when `TRUST_PROXY` is off.
- `rateLimit: false` disables the limiter entirely for callers that
  pass it (used by the existing test suites to avoid interference).

## Out of scope

- Redis / shared-state limiter (for multi-instance deployments).
- Per-key (not per-IP) limits.
- Body-content-aware throttling.
- Adaptive thresholds.
- A `/v1/metrics` endpoint - we just emit structured logs.
