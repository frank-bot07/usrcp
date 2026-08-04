/**
 * Fail fast, with a clear message, on Node.js older than the supported floor.
 *
 * usrcp-core stores its ledger through the built-in `node:sqlite` module, which
 * Node only exposes WITHOUT the `--experimental-sqlite` flag from 22.13.0
 * onward (22.5.0–22.12.x require the flag, so an unflagged `import "node:sqlite"`
 * throws). The same 22.13 floor also makes `require()` of the ESM
 * `usrcp-github` adapter succeed in the rotate-key hook, closing the #147
 * regression tracked as #179 (`require(ESM)` is only supported from 22.12).
 *
 * npm's `engines` field is advisory: it prints a warning but does NOT block
 * `npm install`, `npx`, or a globally linked binary. This runtime guard is
 * what actually enforces the floor, turning an otherwise cryptic
 * `ERR_UNKNOWN_BUILTIN_MODULE` / `ERR_REQUIRE_ESM` deep in a later code path
 * into one actionable line at startup.
 *
 * This module MUST be imported before anything that pulls in `node:sqlite`
 * (i.e. first in the entry point), because a static `import "node:sqlite"`
 * fails at module-evaluation time, before any guard living in the same module
 * graph downstream could run. ES modules evaluate imports depth-first in source
 * order, so importing this first runs the check before usrcp-core is evaluated.
 */

export const MIN_NODE_VERSION = "22.13.0";

/** True when `current` (e.g. "22.8.1") is strictly below `minimum`. */
export function isNodeBelow(current: string, minimum: string): boolean {
  // Strip any prerelease/build suffix (e.g. "23.0.0-nightly") before comparing.
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(current);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

if (isNodeBelow(process.versions.node, MIN_NODE_VERSION)) {
  process.stderr.write(
    `usrcp requires Node.js >= ${MIN_NODE_VERSION}, but this is Node ${process.versions.node}.\n` +
    `usrcp stores its ledger via the built-in node:sqlite module, which Node only\n` +
    `provides without a flag from ${MIN_NODE_VERSION}. Upgrade Node.js and re-run.\n`
  );
  process.exit(1);
}
