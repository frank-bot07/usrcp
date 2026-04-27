/**
 * build.mjs — esbuild-based build for the USRCP Chrome extension
 *
 * Produces dist/ which can be loaded as "Load Unpacked" in chrome://extensions.
 *
 * Three entry points:
 *   src/service-worker.ts → dist/service-worker.js  (SW context, no DOM)
 *   src/content-claude.ts → dist/content-claude.js  (isolated world)
 *   src/page-hook.ts      → dist/page-hook.js        (MAIN world IIFE)
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
  // Remove only browser bundle files; preserve tsc output (setup.js, config.js, etc.)
  for (const f of ["service-worker.js", "content-claude.js", "page-hook.js", "manifest.json"]) {
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
// Page hook — IIFE (injected as a classic <script> into the MAIN world)
// ---------------------------------------------------------------------------

await esbuild.build({
  ...sharedOpts,
  entryPoints: [path.join(__dirname, "src", "page-hook.ts")],
  outfile: path.join(distDir, "page-hook.js"),
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
// Compile setup.ts via tsc for the wizard (invoked separately via npm run lint)
// The setup module uses Node APIs and must be a Node ESM module, not a browser bundle.
// Run: tsc --outDir dist --rootDir src src/setup.ts src/config.ts
// We do this via a child_process here so `npm run build` is a single command.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

const tscBin = path.join(__dirname, "node_modules", ".bin", "tsc");
try {
  execFileSync(
    tscBin,
    ["--outDir", "dist", "--noEmit", "false"],
    { cwd: __dirname, stdio: "inherit" }
  );
} catch (err) {
  // tsc errors are already printed; don't double-print
  process.exit(1);
}

console.log("\n✓ Build complete. Load dist/ as 'Load Unpacked' in chrome://extensions.");
