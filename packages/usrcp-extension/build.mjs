/**
 * build.mjs — esbuild-based build for the USRCP Chrome extension
 *
 * Produces dist/ which can be loaded as "Load Unpacked" in chrome://extensions.
 *
 * Two browser entry points:
 *   src/service-worker.ts → dist/service-worker.js  (SW context, no DOM)
 *   src/content-claude.ts → dist/content-claude.js  (isolated world)
 *
 * page-hook.ts exports a self-contained function that is bundled into the
 * service worker and atomically injected into MAIN world with executeScript.
 *
 * The setup module (src/setup.ts) is compiled separately by tsc (via tsconfig.json)
 * to produce dist/setup.js as a Node ESM module for the wizard. esbuild is only
 * used for the browser-facing scripts.
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Clean dist/
// ---------------------------------------------------------------------------

const distDir = path.join(__dirname, "dist");
if (fs.existsSync(distDir)) {
  // Remove browser bundle files plus stale browser-only compiler output from
  // older layouts; preserve Node-side tsc output (setup.js, config.js, etc.).
  for (const f of [
    "service-worker.js",
    "service-worker.d.ts",
    "service-worker.js.map",
    "content-claude.js",
    "content-claude.d.ts",
    "content-claude.js.map",
    "page-hook.js",
    "page-hook.d.ts",
    "page-hook.js.map",
    "manifest.json",
  ]) {
    const fp = path.join(distDir, f);
    if (fs.existsSync(fp)) fs.rmSync(fp);
  }
}
fs.mkdirSync(distDir, { recursive: true });

// ---------------------------------------------------------------------------
// Common esbuild options
// ---------------------------------------------------------------------------

const sharedOpts = {
  bundle: true,
  platform: /** @type {const} */ ("browser"),
  target: "chrome120",
  sourcemap: false,
  minify: false, // keep readable for debugging in v0
  logLevel: /** @type {const} */ ("info"),
};

// ---------------------------------------------------------------------------
// Service worker — ESM format (Chrome MV3 SWs support ESM)
// ---------------------------------------------------------------------------

await esbuild.build({
  ...sharedOpts,
  entryPoints: [path.join(__dirname, "src", "service-worker.ts")],
  outfile: path.join(distDir, "service-worker.js"),
  format: "esm",
});

// ---------------------------------------------------------------------------
// Content script — IIFE (content scripts are not ES modules)
// ---------------------------------------------------------------------------

await esbuild.build({
  ...sharedOpts,
  entryPoints: [path.join(__dirname, "src", "content-claude.ts")],
  outfile: path.join(distDir, "content-claude.js"),
  format: "iife",
});

// ---------------------------------------------------------------------------
// Copy manifest.json into dist/
// ---------------------------------------------------------------------------

fs.copyFileSync(
  path.join(__dirname, "manifest.json"),
  path.join(distDir, "manifest.json")
);

// ---------------------------------------------------------------------------
// Compile Node-side modules (setup.ts, config.ts) via tsc using
// tsconfig.build.json. The browser-side entry points (service-worker, content-
// claude, page-hook) are esbuild-bundled above; tsc must not emit those, or it
// would clobber the IIFE bundles with non-bundled module output and re-introduce
// `import` statements that MAIN-world content scripts cannot resolve.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

const tscBin = path.join(__dirname, "node_modules", ".bin", "tsc");
try {
  execFileSync(
    tscBin,
    ["-p", "tsconfig.build.json"],
    { cwd: __dirname, stdio: "inherit" }
  );
} catch (err) {
  process.exit(1);
}

console.log("\n✓ Build complete. Load dist/ as 'Load Unpacked' in chrome://extensions.");
