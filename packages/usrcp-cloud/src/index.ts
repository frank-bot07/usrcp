#!/usr/bin/env node
/**
 * Entry point: `usrcp-cloud` binary.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string
 *
 * Optional:
 *   PORT   — HTTP port (default 3000)
 *   HOST   — bind host (default 0.0.0.0)
 */

import { createApp } from "./server.js";
import { createPgPool } from "./db.js";
import { pruneOldNonces } from "./auth.js";

const NONCE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createPgPool(url);
  await db.migrate();

  const app = createApp({ db, logger: true });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen({ port, host });

  // Periodically prune expired nonces so seen_nonces doesn't grow
  // unboundedly. .unref() so the timer doesn't hold the process open.
  const pruneTimer = setInterval(() => {
    pruneOldNonces(db).catch((err) => app.log.error({ err }, "nonce prune failed"));
  }, NONCE_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const shutdown = async () => {
    clearInterval(pruneTimer);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
