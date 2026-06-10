/**
 * Keychain module tests.
 *
 * All child_process calls are mocked — these tests never touch a real OS
 * keychain. Platform is stubbed per-test via Object.defineProperty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  detectKeychain,
  readPassphraseFromKeychain,
  storePassphraseInKeychain,
  clearPassphraseFromKeychain,
  validatePassphraseStorable,
  KeychainError,
} from "../keychain.js";

const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

/** spawnSync result shorthand. */
function res(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr, pid: 1, output: [], signal: null };
}

/** spawnSync result for a timed-out process (killed by SIGTERM, error set). */
function timedOut() {
  return {
    status: null,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: "SIGTERM" as const,
    error: Object.assign(new Error("spawnSync security ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe("detectKeychain", () => {
  it("reports macos-keychain when security exists on darwin", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce(res(0, "/usr/bin/security\n"));
    expect(detectKeychain()).toEqual({ available: true, backend: "macos-keychain" });
    expect(spawnSyncMock).toHaveBeenCalledWith("which", ["security"], expect.anything());
  });

  it("reports unavailable when security is missing on darwin", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce(res(1));
    const k = detectKeychain();
    expect(k.available).toBe(false);
    expect(k.backend).toBeNull();
    expect(k.reason).toMatch(/security/);
  });

  it("reports secret-service when secret-tool exists on linux", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n"));
    expect(detectKeychain()).toEqual({ available: true, backend: "secret-service" });
  });

  it("suggests libsecret-tools when secret-tool is missing on linux", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValueOnce(res(1));
    const k = detectKeychain();
    expect(k.available).toBe(false);
    expect(k.reason).toMatch(/libsecret/);
  });

  it("is unsupported on win32", () => {
    setPlatform("win32");
    const k = detectKeychain();
    expect(k.available).toBe(false);
    expect(k.reason).toMatch(/win32/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe("validatePassphraseStorable", () => {
  it("rejects empty passphrases", () => {
    expect(() => validatePassphraseStorable("")).toThrow(KeychainError);
  });

  it("accepts anything the env-var path accepts — quotes, unicode, even control chars", () => {
    expect(() => validatePassphraseStorable('my "secret" phrase \\ 100% — ünïcode')).not.toThrow();
    expect(() => validatePassphraseStorable("line1\nline2")).not.toThrow();
  });
});

/** The on-keychain encoding for a given passphrase. */
function encoded(passphrase: string): string {
  return "usrcp-b64:" + Buffer.from(passphrase, "utf-8").toString("base64");
}

describe("readPassphraseFromKeychain (darwin)", () => {
  beforeEach(() => setPlatform("darwin"));

  it("decodes a usrcp-b64 entry", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which
      .mockReturnValueOnce(res(0, encoded("hunter2 squad — ünïcode") + "\n"));
    expect(readPassphraseFromKeychain("default")).toBe("hunter2 squad — ünïcode");
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      "security",
      ["find-generic-password", "-s", "usrcp", "-a", "default", "-w"],
      expect.anything()
    );
  });

  it("returns plain (manually created) entries verbatim", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(0, "hunter2 squad\n"));
    expect(readPassphraseFromKeychain("default")).toBe("hunter2 squad");
  });

  it("returns null when the item does not exist (exit 44)", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(44, "", "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."));
    expect(readPassphraseFromKeychain("default")).toBeNull();
  });

  it("returns null when no backend is available", () => {
    spawnSyncMock.mockReturnValueOnce(res(1)); // which security → missing
    expect(readPassphraseFromKeychain("default")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns null instead of hanging when security times out (locked keychain)", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(timedOut());
    expect(readPassphraseFromKeychain("default")).toBeNull();
  });

  it("passes a timeout to every security invocation", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(0, "x\n"));
    readPassphraseFromKeychain("default");
    const opts = spawnSyncMock.mock.calls[1][2];
    expect(opts.timeout).toBeGreaterThan(0);
  });
});

describe("storePassphraseInKeychain (darwin)", () => {
  beforeEach(() => setPlatform("darwin"));

  it("feeds the add command via `security -i` stdin and round-trip verifies", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which (store's detect)
      .mockReturnValueOnce(res(0)) // security -i add
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which (read's detect)
      .mockReturnValueOnce(res(0, encoded("s3cret phrase") + "\n")); // find -w
    const backend = storePassphraseInKeychain("default", "s3cret phrase");
    expect(backend).toBe("macos-keychain");

    const addCall = spawnSyncMock.mock.calls[1];
    expect(addCall[0]).toBe("security");
    expect(addCall[1]).toEqual(["-i"]);
    // Secret travels via stdin (never argv), base64-encoded with prefix
    expect(addCall[2].input).toContain(`-w "${encoded("s3cret phrase")}"`);
    expect(addCall[2].input).toContain('-s "usrcp"');
    expect(addCall[2].input).toContain('-a "default"');
    expect(addCall[2].input).toContain("-U ");
  });

  it("round-trips quotes, backslashes, and unicode via the b64 encoding", () => {
    const tricky = 'pa"ss\\phrase — ünïcode';
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(0))
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(0, encoded(tricky) + "\n"));
    storePassphraseInKeychain("default", tricky);
    const input: string = spawnSyncMock.mock.calls[1][2].input;
    // No raw quote/backslash from the passphrase reaches the -i parser
    expect(input).toContain(`-w "${encoded(tricky)}"`);
    expect(encoded(tricky)).toMatch(/^usrcp-b64:[A-Za-z0-9+/=]+$/);
  });

  it("deletes the entry and throws when round-trip verification fails", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which (store)
      .mockReturnValueOnce(res(0)) // add succeeds
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which (read)
      .mockReturnValueOnce(res(0, encoded("mangled-by-backend") + "\n")) // wrong value back
      .mockReturnValueOnce(res(0, "/usr/bin/security\n")) // which (clear)
      .mockReturnValueOnce(res(0)); // delete-generic-password
    expect(() => storePassphraseInKeychain("default", "deadbeef")).toThrow(/round-trip/);
    const deleteCall = spawnSyncMock.mock.calls[5];
    expect(deleteCall[1]).toEqual(["delete-generic-password", "-s", "usrcp", "-a", "default"]);
  });

  it("throws KeychainError when the add command fails", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(51, "", "security: keychain is locked"));
    expect(() => storePassphraseInKeychain("default", "ok phrase")).toThrow(KeychainError);
  });

  it("refuses empty passphrases before touching the backend", () => {
    expect(() => storePassphraseInKeychain("default", "")).toThrow(/empty/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("throws a locked-keychain hint instead of hanging when the store times out", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(timedOut());
    expect(() => storePassphraseInKeychain("default", "ok phrase")).toThrow(/locked/);
  });
});

describe("secret-service backend (linux)", () => {
  beforeEach(() => setPlatform("linux"));

  it("stores via secret-tool with the encoded secret on stdin and verifies", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n")) // which (store)
      .mockReturnValueOnce(res(0)) // secret-tool store
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n")) // which (read)
      .mockReturnValueOnce(res(0, encoded("my linux phrase") + "\n")); // lookup
    const backend = storePassphraseInKeychain("frank", "my linux phrase");
    expect(backend).toBe("secret-service");

    const storeCall = spawnSyncMock.mock.calls[1];
    expect(storeCall[0]).toBe("secret-tool");
    expect(storeCall[1]).toEqual([
      "store",
      "--label=USRCP passphrase (frank)",
      "service",
      "usrcp",
      "account",
      "frank",
    ]);
    expect(storeCall[2].input).toBe(encoded("my linux phrase"));
  });

  it("reads via secret-tool lookup", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n"))
      .mockReturnValueOnce(res(0, encoded("my linux phrase") + "\n"));
    expect(readPassphraseFromKeychain("frank")).toBe("my linux phrase");
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      "secret-tool",
      ["lookup", "service", "usrcp", "account", "frank"],
      expect.anything()
    );
  });

  it("returns null when lookup finds nothing", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n"))
      .mockReturnValueOnce(res(1));
    expect(readPassphraseFromKeychain("frank")).toBeNull();
  });

  it("clear returns false when nothing was removed", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n"))
      .mockReturnValueOnce(res(1));
    expect(clearPassphraseFromKeychain("frank")).toBe(false);
  });

  it("surfaces a helpful error when the secret service daemon is absent", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/secret-tool\n"))
      .mockReturnValueOnce(res(1, "", "secret-tool: Cannot autolaunch D-Bus without X11"));
    expect(() => storePassphraseInKeychain("frank", "phrase here")).toThrow(/gnome-keyring/);
  });
});

describe("clearPassphraseFromKeychain (darwin)", () => {
  beforeEach(() => setPlatform("darwin"));

  it("returns true when an entry was deleted", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(0));
    expect(clearPassphraseFromKeychain("default")).toBe(true);
  });

  it("returns false when no entry existed", () => {
    spawnSyncMock
      .mockReturnValueOnce(res(0, "/usr/bin/security\n"))
      .mockReturnValueOnce(res(44));
    expect(clearPassphraseFromKeychain("default")).toBe(false);
  });
});
