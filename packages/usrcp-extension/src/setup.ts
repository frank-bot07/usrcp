/**
 * runExtensionSetup — wizard integration for the USRCP browser extension.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=extension`) via the
 * convention-based dispatcher in packages/usrcp-local/src/setup.ts.
 *
 * Function name follows the convention: usrcp-extension → runExtensionSetup
 * (same pattern as runDiscordSetup, runTelegramSetup, etc.)
 *
 * Flow:
 *   1. Verify usrcp-bridge.js exists (build check).
 *   2. Instruct user to load extension unpacked in Chrome.
 *   3. Prompt for extension ID (validated as 32 lowercase a-p chars).
 *   4. Write Chrome NM manifest with absolute bridge path + extension ID.
 *   5. Write ~/.usrcp/extension-config.json (mode 0600).
 *   6. Print verification instructions.
 *   7. Return ExtensionConfig.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import {
  type ExtensionConfig,
  getConfigPath,
  getNMManifestPath,
  writeExtensionConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Extension ID validation
// Chrome extension IDs are 32 lowercase letters a-p (base-16 encoded hash).
// ---------------------------------------------------------------------------

const EXTENSION_ID_RE = /^[a-p]{32}$/;

function isValidExtensionId(id: string): boolean {
  return EXTENSION_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Prompt helpers (no external dep — mirrors discord adapter pattern)
// ---------------------------------------------------------------------------

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tryOpenChrome(): void {
  try {
    if (process.platform === "darwin") {
      execSync('open -a "Google Chrome" "chrome://extensions"', { stdio: "ignore" });
    }
    // Linux: xdg-open doesn't handle chrome:// URLs reliably — skip
  } catch {
    // Ignore — user will navigate manually
  }
}

// ---------------------------------------------------------------------------
// NM manifest builder
// ---------------------------------------------------------------------------

interface NMManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

function buildNMManifest(bridgePath: string, extensionId: string): NMManifest {
  return {
    name: "com.usrcp.bridge",
    description: "USRCP browser extension bridge",
    path: bridgePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

export async function runExtensionSetup(): Promise<ExtensionConfig> {
  process.stderr.write("\n");
  process.stderr.write("  ┌─ Browser extension setup ───────────────────────────────────┐\n");
  process.stderr.write("  │ Connects Chrome to your USRCP ledger via Native Messaging.    │\n");
  process.stderr.write("  │ Chrome only in v0. Firefox support deferred to v0.1.          │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Step 1: Verify the bridge exists ─────────────────────────────────────

  // Resolve relative to this file's location in dist/
  // __dirname in dist/ = packages/usrcp-extension/dist/
  // Bridge lives at packages/usrcp-extension/native-host/usrcp-bridge.js
  const pkgDir = path.resolve(__dirname, "..");
  const bridgePath = path.join(pkgDir, "native-host", "usrcp-bridge.js");

  if (!fs.existsSync(bridgePath)) {
    throw new Error(
      `Native host not found at:\n  ${bridgePath}\n\n` +
      "The native host ships alongside the package and should be present. " +
      "If you cloned the repo, ensure the file exists:\n" +
      "  packages/usrcp-extension/native-host/usrcp-bridge.js"
    );
  }

  // Ensure the bridge is executable
  try {
    fs.chmodSync(bridgePath, 0o755);
  } catch {
    process.stderr.write(`  ⚠ Could not chmod ${bridgePath} — you may need to run:\n`);
    process.stderr.write(`    chmod +x "${bridgePath}"\n\n`);
  }

  process.stderr.write(`  ✓ Native host found at:\n`);
  process.stderr.write(`    ${bridgePath}\n\n`);

  // Resolve the dist/ directory path for "Load Unpacked" instructions
  const distDir = path.join(pkgDir, "dist");

  // ── Step 2: Load Unpacked instructions ────────────────────────────────────

  process.stderr.write("  Step 1 — Load the extension in Chrome\n");
  process.stderr.write("  ──────────────────────────────────────\n");
  process.stderr.write("  1. Open Chrome → chrome://extensions\n");
  process.stderr.write("  2. Enable 'Developer mode' (toggle in the top-right corner)\n");
  process.stderr.write("  3. Click 'Load unpacked'\n");
  process.stderr.write(`  4. Select this folder:\n`);
  process.stderr.write(`       ${distDir}\n\n`);

  if (process.stderr.isTTY) {
    process.stderr.write("  Attempting to open Chrome at chrome://extensions...\n");
    tryOpenChrome();
    process.stderr.write("  (If Chrome didn't open, navigate there manually.)\n\n");
  }

  process.stderr.write("  After loading, Chrome will show a card for 'USRCP' with an\n");
  process.stderr.write("  extension ID like: 'abcdefghijklmnopabcdefghijklmnop'\n\n");

  await readLine("  Press Enter once you've loaded the extension in Chrome...");
  process.stderr.write("\n");

  // ── Step 3: Prompt for extension ID ──────────────────────────────────────

  process.stderr.write("  Step 2 — Extension ID\n");
  process.stderr.write("  ──────────────────────\n");
  process.stderr.write("  Look at the USRCP card in chrome://extensions.\n");
  process.stderr.write("  The extension ID is 32 lowercase letters (a-p) shown below the name.\n\n");

  let extensionId = "";
  while (true) {
    extensionId = await readLine("  Paste extension ID: ");
    if (!extensionId) {
      process.stderr.write("  Extension ID cannot be empty. Try again.\n");
      continue;
    }
    if (!isValidExtensionId(extensionId)) {
      process.stderr.write(
        `  Invalid format: expected 32 lowercase letters a-p, got: ${extensionId}\n` +
        "  Try again.\n"
      );
      continue;
    }
    process.stderr.write(`  ✓ Extension ID: ${extensionId}\n\n`);
    break;
  }

  // ── Step 4: Write NM manifest ─────────────────────────────────────────────

  process.stderr.write("  Step 3 — Installing Native Messaging manifest\n");
  process.stderr.write("  ─────────────────────────────────────────────\n");

  let manifestPath: string;
  try {
    manifestPath = getNMManifestPath();
  } catch (err) {
    throw new Error(
      `Cannot determine NM manifest path: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const nmManifest = buildNMManifest(bridgePath, extensionId);
  const nmDir = path.dirname(manifestPath);

  if (!fs.existsSync(nmDir)) {
    fs.mkdirSync(nmDir, { recursive: true });
  }

  fs.writeFileSync(manifestPath, JSON.stringify(nmManifest, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o644,
    flag: "w",
  });

  process.stderr.write(`  ✓ NM manifest written to:\n`);
  process.stderr.write(`    ${manifestPath}\n\n`);

  // ── Step 5: Write extension-config.json ───────────────────────────────────

  const cfg: ExtensionConfig = {
    extension_id: extensionId,
    bridge_path: bridgePath,
    manifest_path: manifestPath,
    configured_at: new Date().toISOString(),
  };

  writeExtensionConfig(cfg);
  process.stderr.write(`  ✓ Config saved to ${getConfigPath()} (mode 0600)\n\n`);

  // ── Step 6: Verification ──────────────────────────────────────────────────

  process.stderr.write("  ✓ Setup complete!\n\n");
  process.stderr.write("  Verification:\n");
  process.stderr.write("  1. Reload the USRCP extension in chrome://extensions\n");
  process.stderr.write("     (click the reload icon on the extension card)\n");
  process.stderr.write("  2. Open claude.ai and start a conversation.\n");
  process.stderr.write("  3. Type '/usrcp test' in the composer and press Enter.\n");
  process.stderr.write("     If you see ledger context inserted, everything is working.\n");
  process.stderr.write("  4. After a claude.ai conversation, check that a turn was captured:\n");
  process.stderr.write("     usrcp status\n\n");
  process.stderr.write("  Note: The extension ID is tied to the unpacked load path.\n");
  process.stderr.write("  If you move the dist/ folder, re-run this setup.\n\n");

  return cfg;
}
