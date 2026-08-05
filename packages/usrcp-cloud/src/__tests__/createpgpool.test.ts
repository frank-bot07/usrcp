import { describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { createPgPool } from "../db.js";

/**
 * Regression for #201. In production, createPgPool builds a real pg Pool. When
 * the server drops an idle client (a PG restart, or a Neon/Railway/RDS
 * idle-connection reaper), node-postgres emits 'error' on the pool. Before the
 * fix there was no listener, so Node treated it as an unhandled 'error' event
 * and crashed the whole server process. The fix attaches a logging handler and
 * lets the pool evict the dead client so the next query reconnects.
 */
describe("createPgPool idle-client error handling (#201)", () => {
  it("attaches a pool 'error' listener so an idle-client error does not crash the process", async () => {
    // Unreachable target on purpose; no query is issued, so no real connection
    // is opened (node-postgres connects lazily on first acquire).
    const db = createPgPool("postgresql://u:p@127.0.0.1:1/does-not-connect");
    const pool = (db as unknown as { pool: Pool }).pool;

    // The fix attaches exactly this listener.
    expect(pool.listenerCount("error")).toBeGreaterThanOrEqual(1);

    // With a listener present the emit is swallowed; with none, Node's
    // EventEmitter rethrows it, which is the crash this guards against.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => pool.emit("error", new Error("idle client dropped"))).not.toThrow();
    errSpy.mockRestore();

    await pool.end();
  });
});
