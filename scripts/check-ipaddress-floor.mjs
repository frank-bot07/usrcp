#!/usr/bin/env node
// Supply-chain guard for the ip-address SSRF / trust-boundary advisories
// (GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh): fail if ANY package lockfile in
// the repo resolves ip-address below the first patched release, 10.3.1.
//
// This exists because the `audit` job runs a blanket `npm audit` only on
// usrcp-core and usrcp-local. It cannot be widened to packages like
// usrcp-vscode without also red-flagging that package's separate, deferred
// SDK-cluster advisories (hono / @hono/node-server, tracked under #156). This
// check is scoped to the one class instead, so an ip-address regression in any
// lockfile (published or not) is visible in CI without coupling to the
// deferred cluster.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIN = [10, 3, 1];
function belowFloor(version) {
  const p = version.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (p[i] || 0) - MIN[i];
    if (d !== 0) return d < 0;
  }
  return false;
}

const roots = ["packages", "release/extra-names"];
const offenders = [];
let scanned = 0;

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root)) {
    const lockPath = join(root, dir, "package-lock.json");
    if (!existsSync(lockPath)) continue;
    scanned++;
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const [name, node] of Object.entries(lock.packages || {})) {
      if (name.endsWith("node_modules/ip-address") && node.version && belowFloor(node.version)) {
        offenders.push(`${lockPath}: ${name} = ${node.version}`);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error("Vulnerable ip-address (< 10.3.1) resolved in:");
  for (const o of offenders) console.error("  " + o);
  console.error("Bump the pulling dependency (e.g. express-rate-limit >= 8.5.2) or add an npm override.");
  process.exit(1);
}
console.log(`ip-address >= 10.3.1 in every lockfile that resolves it (${scanned} lockfiles scanned).`);
