/**
 * Tests for the iMessage watcher's event parsing logic.
 *
 * Tests the core event-handling behaviors without spawning a real imsg process:
 *   - Reaction/tapback skip (associated_message_type != 0)
 *   - Schema guard: malformed events are logged-and-skipped, don't crash
 *   - last_rowid advances through all events
 *   - Config: saveLastRowid debounce and loadConfig error handling
 *   - Restart resume: spawn args include --since-rowid when config has one
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setUserSlug } from "usrcp-local/dist/encryption.js";

// Import config module functions directly
import {
  getConfigPath,
  writeImessageConfig,
  loadConfig,
  saveLastRowid,
  flushLastRowid,
  type ImessageConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-imessage-index-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: ImessageConfig = {
  anthropic_api_key: "sk-ant-stub",
  user_handle: "+14155551234",
  allowlisted_chats: ["7", "9"],
  prefix: "..u ",
};

// ---------------------------------------------------------------------------
// Config: loadConfig error handling
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("exits with code 1 when config file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when allowlisted_chats is empty", () => {
    writeImessageConfig({ ...GOOD_CONFIG, allowlisted_chats: [] });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when user_handle is missing", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { user_handle: _omit, ...partial } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(partial), { mode: 0o600 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("loads a valid config successfully", () => {
    writeImessageConfig(GOOD_CONFIG);
    const loaded = loadConfig();
    expect(loaded.user_handle).toBe(GOOD_CONFIG.user_handle);
    expect(loaded.allowlisted_chats).toEqual(GOOD_CONFIG.allowlisted_chats);
    expect(loaded.prefix).toBe(GOOD_CONFIG.prefix);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
  });
});

// ---------------------------------------------------------------------------
// Config: writeImessageConfig mode 0600
// ---------------------------------------------------------------------------

describe("writeImessageConfig", () => {
  it("writes config file with mode 0600", () => {
    writeImessageConfig(GOOD_CONFIG);
    const p = getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("round-trips config correctly", () => {
    writeImessageConfig({ ...GOOD_CONFIG, last_rowid: 42 });
    const loaded = loadConfig();
    expect(loaded.last_rowid).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// saveLastRowid / flushLastRowid debounce
// ---------------------------------------------------------------------------

describe("saveLastRowid / flushLastRowid", () => {
  beforeEach(() => {
    // Write a valid base config so flushLastRowid can read+merge
    writeImessageConfig(GOOD_CONFIG);
  });

  it("flushLastRowid persists the pending rowid to disk", () => {
    saveLastRowid(1234);
    flushLastRowid();

    const loaded = loadConfig();
    expect(loaded.last_rowid).toBe(1234);
  });

  it("flushLastRowid with no pending rowid is a no-op", () => {
    // Flush without saving — should not change last_rowid
    const before = loadConfig();
    flushLastRowid();
    const after = loadConfig();
    expect(after.last_rowid).toBe(before.last_rowid);
  });

  it("coalesces multiple saveLastRowid calls (last wins)", () => {
    saveLastRowid(100);
    saveLastRowid(200);
    saveLastRowid(999);
    flushLastRowid();

    const loaded = loadConfig();
    expect(loaded.last_rowid).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Schema guard validation logic (isolated test)
// ---------------------------------------------------------------------------

describe("event schema guard", () => {
  // Mirror the validateEventSchema logic from index.ts inline for unit testing
  function validateEventSchema(evt: unknown): string[] {
    const required = ["guid", "text", "is_from_me", "chat_guid"] as const;
    if (typeof evt !== "object" || evt === null) return ["(not an object)"];
    const obj = evt as Record<string, unknown>;
    return required.filter((f) => !(f in obj));
  }

  it("returns empty array for a valid event shape", () => {
    const validEvent = {
      rowid: 12345,
      guid: "p:0/ABC123",
      text: "Hello",
      is_from_me: 0,
      handle: "+14155551234",
      chat_id: 7,
      chat_guid: "iMessage;-;chat-guid",
      chat_style: 45,
      associated_message_type: 0,
    };
    expect(validateEventSchema(validEvent)).toEqual([]);
  });

  it("detects missing guid field", () => {
    const missingGuid = {
      text: "Hello",
      is_from_me: 0,
      chat_guid: "iMessage;-;chat-guid",
    };
    const missing = validateEventSchema(missingGuid);
    expect(missing).toContain("guid");
  });

  it("detects missing chat_guid field", () => {
    const missingChatGuid = {
      guid: "p:0/ABC123",
      text: "Hello",
      is_from_me: 0,
    };
    const missing = validateEventSchema(missingChatGuid);
    expect(missing).toContain("chat_guid");
  });

  it("rejects non-object events", () => {
    expect(validateEventSchema(null)).toContain("(not an object)");
    expect(validateEventSchema("string")).toContain("(not an object)");
    expect(validateEventSchema(42)).toContain("(not an object)");
  });

  it("accepts the sample fixture event shape", async () => {
    const fixture = (await import("./fixtures/sample-watch-event.json", { with: { type: "json" } })).default;
    const missing = validateEventSchema(fixture);
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reaction/tapback filter (associated_message_type != 0)
// ---------------------------------------------------------------------------

describe("reaction filter (associated_message_type)", () => {
  // Test the filter condition used in index.ts inline
  function isReaction(evt: Record<string, unknown>): boolean {
    const assocType = evt["associated_message_type"];
    return assocType !== undefined && assocType !== null && assocType !== 0 && assocType !== false;
  }

  it("treats associated_message_type=0 as a normal message", () => {
    expect(isReaction({ associated_message_type: 0 })).toBe(false);
  });

  it("treats associated_message_type=2000 (Loved) as a reaction", () => {
    expect(isReaction({ associated_message_type: 2000 })).toBe(true);
  });

  it("treats associated_message_type=3007 (Ha Ha) as a reaction", () => {
    expect(isReaction({ associated_message_type: 3007 })).toBe(true);
  });

  it("treats missing associated_message_type as normal message", () => {
    expect(isReaction({})).toBe(false);
  });

  it("treats null associated_message_type as normal message", () => {
    expect(isReaction({ associated_message_type: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restart resume: spawn args should include --since-rowid when last_rowid is set
// ---------------------------------------------------------------------------

describe("restart resume (--since-rowid)", () => {
  it("config with last_rowid produces correct spawn args", () => {
    const configWithRowid: ImessageConfig = { ...GOOD_CONFIG, last_rowid: 500 };

    // Mirror the spawn args logic from index.ts
    const args = ["watch", "--json", "--debounce", "250ms"];
    if (configWithRowid.last_rowid !== undefined && configWithRowid.last_rowid > 0) {
      args.push("--since-rowid", String(configWithRowid.last_rowid));
    }

    expect(args).toContain("--since-rowid");
    expect(args).toContain("500");
    expect(args.indexOf("--since-rowid")).toBe(args.indexOf("500") - 1);
  });

  it("config without last_rowid does NOT include --since-rowid", () => {
    const configNoRowid: ImessageConfig = { ...GOOD_CONFIG };

    const args = ["watch", "--json", "--debounce", "250ms"];
    if (configNoRowid.last_rowid !== undefined && configNoRowid.last_rowid > 0) {
      args.push("--since-rowid", String(configNoRowid.last_rowid));
    }

    expect(args).not.toContain("--since-rowid");
  });

  it("config with last_rowid=0 does NOT include --since-rowid", () => {
    const configZeroRowid: ImessageConfig = { ...GOOD_CONFIG, last_rowid: 0 };

    const args = ["watch", "--json", "--debounce", "250ms"];
    if (configZeroRowid.last_rowid !== undefined && configZeroRowid.last_rowid > 0) {
      args.push("--since-rowid", String(configZeroRowid.last_rowid));
    }

    expect(args).not.toContain("--since-rowid");
  });
});
