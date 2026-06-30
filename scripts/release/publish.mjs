#!/usr/bin/env node
/**
 * Coordinated npm release for the USRCP packages.
 *
 * The monorepo wires inter-package deps as `file:../usrcp-<x>` so the
 * per-package dev/CI/brew flow (each package independently `npm ci`'d and
 * built) keeps working without a workspace root. Those `file:` specs can't
 * be published — a consumer doing `npm i usrcp-linear` needs a registry
 * range, not a path on the maintainer's disk.
 *
 * This script bridges the two worlds at release time only:
 *
 *   1. Verify the git tree is clean (so the restore in step 5 is safe).
 *   2. Build every publishable package in dependency order.
 *   3. Rewrite each `file:../usrcp-<x>` dep to `^<that package's version>`.
 *   4. `npm pack` (default, dry-run) or `npm publish` (with --execute) each
 *      package in dependency order.
 *   5. Restore the package.json files via `git checkout` — ALWAYS, even on
 *      failure — so the working tree never keeps the rewritten specs.
 *
 * Default is a DRY RUN: it builds, rewrites, `npm pack`s each package to a
 * tarball under release-artifacts/, prints the rewritten deps + tarball
 * file list, and restores. Nothing leaves the machine. Pass --execute to
 * actually `npm publish` (CI does this on a version tag with NODE_AUTH_TOKEN
 * in the environment).
 *
 * Usage:
 *   node scripts/release/publish.mjs            # dry run (pack + inspect)
 *   node scripts/release/publish.mjs --execute  # real npm publish (needs auth)
 *   node scripts/release/publish.mjs --only=usrcp-local,usrcp-linear
 *   node scripts/release/publish.mjs --exclude=usrcp-imessage   # darwin-only; publish it from a macOS runner
 *
 * --only and --exclude compose (only-set minus exclude-set). usrcp-imessage
 * is darwin-only (`"os": ["darwin"]`) — it can't `npm ci`/build on Linux, so
 * the Linux release run excludes it and a macOS run publishes it via --only.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PKG_DIR = path.join(REPO_ROOT, "packages");
const ARTIFACT_DIR = path.join(REPO_ROOT, "release-artifacts");

/**
 * Publish order. Each tier may publish in parallel in principle, but we go
 * strictly sequentially so a failure stops the release before dependents
 * ship against a version that never made it to the registry.
 *
 *   tier 0: framework-agnostic core — no internal deps
 *   tier 1: depend on tier 0
 *   tier 2: depend on tier 0 + tier 1
 *   tier 3: adapters — depend on tier 0 + tier 1 + tier 2
 *
 * Excluded by design:
 *   usrcp-cloud    — hosted server, deployed not npm-installed
 *   usrcp-vscode   — ships via the VS Code marketplace
 *   usrcp-hermes   — Python, ships via pip
 */
const PUBLISH_ORDER = [
  // tier 0 — the protocol core (encrypted ledger, crypto, pairing, scope)
  "usrcp-core",
  // tier 1 — the local MCP server + CLI
  "usrcp-local",
  // tier 2
  "usrcp-adapter-kit",
  "usrcp-stream",
  // tier 3 — capture adapters + harness integrations
  "usrcp-obsidian",
  "usrcp-linear",
  "usrcp-github",
  "usrcp-gmail",
  "usrcp-google-calendar",
  "usrcp-discord",
  "usrcp-telegram",
  "usrcp-slack",
  "usrcp-imessage",
  "usrcp-claude-code",
  "usrcp-extension",
];

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const onlyArg = args.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
const excludeArg = args.find((a) => a.startsWith("--exclude="));
const EXCLUDE = excludeArg ? excludeArg.slice("--exclude=".length).split(",") : [];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function run(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
}

function readPkg(name) {
  const p = path.join(PKG_DIR, name, "package.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function gitTreeClean() {
  const out = run("git", ["status", "--porcelain"], REPO_ROOT).trim();
  return out.length === 0;
}

/** Map every publishable package name → its current version. */
function versionIndex() {
  const idx = {};
  for (const name of PUBLISH_ORDER) idx[name] = readPkg(name).version;
  return idx;
}

/**
 * Rewrite `file:../usrcp-<x>` deps to `^<version>` for every internal dep,
 * in place on disk. Returns the list of package.json paths touched so the
 * caller can restore them.
 */
function rewriteDeps(versions, touched = []) {
  for (const name of PUBLISH_ORDER) {
    const pkgPath = path.join(PKG_DIR, name, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    let changed = false;
    for (const field of ["dependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const [dep, spec] of Object.entries(deps)) {
        if (typeof spec === "string" && spec.startsWith("file:")) {
          const ver = versions[dep];
          if (!ver) {
            throw new Error(
              `${name}: ${field}.${dep} is "${spec}" but ${dep} is not in PUBLISH_ORDER — cannot resolve a version to publish against.`,
            );
          }
          deps[dep] = `^${ver}`;
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      touched.push(pkgPath);
    }
  }
  return touched;
}

function restore(touchedPaths) {
  if (touchedPaths.length === 0) return;
  const rel = touchedPaths.map((p) => path.relative(REPO_ROOT, p));
  run("git", ["checkout", "--", ...rel], REPO_ROOT);
}

/**
 * True if `name@version` is already on the registry. Makes the publish
 * resumable: a re-run after a partial failure (e.g. npm's E429 new-package
 * rate limit tripping mid-batch) skips what already shipped instead of
 * erroring on "cannot publish over existing version". `npm view` exits
 * non-zero when the exact version doesn't exist — we treat that as "not
 * published". Any other failure (network) also returns false so we still
 * attempt the publish and surface the real error there.
 */
function isAlreadyPublished(name, version) {
  try {
    const out = run("npm", ["view", `${name}@${version}`, "version"], REPO_ROOT).trim();
    return out === version;
  } catch {
    return false;
  }
}

function showRewrittenDeps(name) {
  const pkg = readPkg(name);
  const internal = Object.entries(pkg.dependencies || {})
    .filter(([d]) => PUBLISH_ORDER.includes(d))
    .map(([d, v]) => `${d}@${v}`);
  if (internal.length) log(`    deps: ${internal.join(", ")}`);
}

function main() {
  const targets = (ONLY
    ? PUBLISH_ORDER.filter((n) => ONLY.includes(n))
    : PUBLISH_ORDER
  ).filter((n) => !EXCLUDE.includes(n));
  if (targets.length === 0) {
    throw new Error(
      `No packages to publish after --only/--exclude. Known: ${PUBLISH_ORDER.join(", ")}`,
    );
  }
  if (EXCLUDE.length) log(`excluding: ${EXCLUDE.join(", ")}`);

  if (!gitTreeClean()) {
    throw new Error(
      "git tree is not clean. Commit or stash first — this script rewrites package.json files and restores them via `git checkout`, which would clobber unrelated edits.",
    );
  }

  const versions = versionIndex();
  log(`USRCP release — ${EXECUTE ? "PUBLISH (live)" : "DRY RUN (pack only)"}`);
  log(`Versions: ${Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(", ")}`);
  log("");

  // Step 1: build everything in order (each package's prebuild handles its
  // own sibling chain; building here too makes the dist/ guaranteed-fresh
  // and surfaces a type error before any rewrite/publish happens).
  for (const name of targets) {
    log(`building ${name} …`);
    run("npm", ["run", "build"], path.join(PKG_DIR, name));
  }
  log("");

  if (!EXECUTE) {
    fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true });
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  // Step 2: rewrite deps. Track paths incrementally so restoration also runs
  // if rewriteDeps itself fails midway through a package set.
  const touched = [];
  try {
    rewriteDeps(versions, touched);
    for (const name of targets) {
      const dir = path.join(PKG_DIR, name);
      if (EXECUTE) {
        if (isAlreadyPublished(name, versions[name])) {
          log(`skipping ${name}@${versions[name]} — already on registry`);
          continue;
        }
        log(`publishing ${name} …`);
        showRewrittenDeps(name);
        run("npm", ["publish", "--access", "public"], dir);
      } else {
        log(`packing ${name} …`);
        showRewrittenDeps(name);
        const out = run("npm", ["pack", "--pack-destination", ARTIFACT_DIR], dir).trim();
        const tgz = out.split("\n").pop().trim();
        log(`    → release-artifacts/${tgz}`);
      }
    }
  } finally {
    restore(touched);
    log("");
    log("restored package.json files (file: deps back in working tree).");
  }

  log("");
  log(
    EXECUTE
      ? "✓ publish complete."
      : "✓ dry run complete. Inspect release-artifacts/*.tgz; re-run with --execute (and npm auth) to publish.",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nrelease failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
