import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// This import registers the adapter-rotation recovery hook on usrcp-core's
// ledger — exactly the integration this test exercises: the core ledger's
// open-time recovery seam wired to usrcp-local's adapter rotation.
import "../register-adapter-rotation-hook.js";
import { Ledger } from "usrcp-core/ledger";

describe("Adapter-config rotation recovery on Ledger open (PR #67)", () => {
  it("resumes adapter-config rotation from a checkpoint on Ledger open", async () => {
    // Build an isolated HOME so the recovery sweep targets a tmp keys dir,
    // not the developer's real ~/.usrcp.
    const origHome = process.env.HOME;
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-resume-test-"));
    process.env.HOME = isoHome;

    try {
      const isoDbPath = path.join(isoHome, "ledger.db");
      const setupLedger = new Ledger(isoDbPath);
      setupLedger.updateIdentity({ display_name: "Resume Test" });
      const masterKey = Buffer.from((setupLedger as any).masterKey);
      setupLedger.close();

      // Hand-craft an adapter-rotation.json checkpoint in the user's
      // keys dir, sealed under the current master key (which is what
      // the recovery path will see when it reopens the ledger).
      const {
        encrypt,
        deriveGlobalEncryptionKey,
        getUserDir,
      } = await vi.importActual<typeof import("usrcp-core/encryption")>("usrcp-core/encryption");
      const globalKey = deriveGlobalEncryptionKey(masterKey);
      const fakeOldKey = Buffer.alloc(32, 0x42);
      const userDir = getUserDir();
      const checkpointPath = path.join(userDir, "keys", "adapter-rotation.json");
      fs.writeFileSync(
        checkpointPath,
        JSON.stringify({
          v: 1,
          started_at: new Date().toISOString(),
          old_key_enc: encrypt(fakeOldKey.toString("base64"), globalKey),
          // No actual adapter packages are installed in this iso HOME, so
          // the dispatcher will see an empty pending list (all silently
          // skipped) and unlink the checkpoint.
          pending: [],
          completed: [{ adapter: "gmail", status: "rotated" }],
          failed: [],
        }),
      );

      // Reopen the ledger - the constructor should detect the checkpoint,
      // run the recovery sweep, and remove the file. The file's absence
      // post-reopen is the visible witness that the wiring works.
      const recovered = new Ledger(isoDbPath);
      try {
        expect(fs.existsSync(checkpointPath)).toBe(false);
      } finally {
        recovered.close();
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(isoHome, { recursive: true, force: true }); } catch {}
    }
  });
});
