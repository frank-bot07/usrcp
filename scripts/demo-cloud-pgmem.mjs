#!/usr/bin/env node
/**
 * Zero-infra usrcp-cloud for demos: the real Fastify app (createApp) on an
 * in-process pg-mem database. No Docker, no Postgres install — scenario 3 of
 * tasks/32-demo-script.md (multi-device pairing) runs against this directly.
 *
 * This is the same substrate the usrcp-cloud test suite runs on. It is NOT
 * for production use: data lives in process memory and vanishes on exit,
 * and pg-mem skips a few Postgres behaviors the code handles defensively
 * (see the pg-mem comments in packages/usrcp-cloud/src/pairing.ts).
 *
 * Usage:
 *   (cd packages/usrcp-cloud && npm install && npm run build)   # one-time
 *   node scripts/demo-cloud-pgmem.mjs [port]                    # default 19090
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_PKG = path.resolve(__dirname, "..", "packages", "usrcp-cloud");
const require = createRequire(path.join(CLOUD_PKG, "package.json"));

let newDb, Db, SCHEMA_SQL, createApp;
try {
  ({ newDb } = require("pg-mem"));
  ({ Db } = require(path.join(CLOUD_PKG, "dist", "db.js")));
  ({ SCHEMA_SQL } = require(path.join(CLOUD_PKG, "dist", "schema.js")));
  ({ createApp } = require(path.join(CLOUD_PKG, "dist", "server.js")));
} catch (err) {
  console.error("Could not load usrcp-cloud. Build it first:");
  console.error("  (cd packages/usrcp-cloud && npm install && npm run build)");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

const port = Number(process.argv[2] ?? 19090);

const mem = newDb({ autoCreateForeignKeyIndices: true });
mem.public.none(SCHEMA_SQL);
const { Pool } = mem.adapters.createPg();
const db = new Db(new Pool());

const app = createApp({ db, logger: false });
await app.listen({ port, host: "127.0.0.1" });

console.log(`usrcp-cloud (pg-mem, ephemeral) listening on http://127.0.0.1:${port}`);
console.log("");
console.log("Point devices at it:");
console.log(`  usrcp config set cloud_endpoint http://127.0.0.1:${port}`);
console.log("");
console.log("Ctrl-C to stop. All relay state is lost on exit (by design).");
