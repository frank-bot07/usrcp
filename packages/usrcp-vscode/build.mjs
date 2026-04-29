/**
 * build.mjs — esbuild bundle for the USRCP VS Code extension.
 *
 * VS Code loads `dist/extension.js` and runs it in Node, so we bundle
 * the SDK + project sources into a single CommonJS file with `vscode`
 * marked external (the host injects it).
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");

if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(__dirname, "src", "extension.ts")],
  outfile: path.join(distDir, "extension.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

console.log("\n✓ Build complete — dist/extension.js");
