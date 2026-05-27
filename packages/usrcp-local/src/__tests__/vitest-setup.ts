// Disable the v0.1.5 rotateKey rate limit in tests. Production default is 24h,
// but unit tests routinely call rotateKey several times per test to verify
// rotation semantics; without this override every second call would throw
// RotationRateLimitedError. Tests that specifically exercise the rate limit
// re-enable it locally.
process.env.USRCP_ROTATE_KEY_MIN_INTERVAL_HOURS = "0";
