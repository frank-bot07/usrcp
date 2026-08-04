import { describe, it, expect } from "vitest";
import { isNodeBelow, MIN_NODE_VERSION } from "../check-node.js";

// #179: the runtime Node floor guard. npm `engines` is advisory, so this
// comparison is what actually enforces >= 22.13.0 (the version at which
// node:sqlite is unflagged and require() of the ESM github adapter works).

describe("isNodeBelow", () => {
  it("flags versions in the unsupported 22.5–22.12 slice", () => {
    for (const v of ["22.5.0", "22.8.1", "22.11.0", "22.12.0", "22.12.99"]) {
      expect(isNodeBelow(v, MIN_NODE_VERSION)).toBe(true);
    }
  });

  it("accepts the floor and everything above it", () => {
    for (const v of ["22.13.0", "22.13.1", "22.20.0", "23.4.0", "24.0.0", "26.1.0"]) {
      expect(isNodeBelow(v, MIN_NODE_VERSION)).toBe(false);
    }
  });

  it("rejects older majors and accepts the boundary exactly", () => {
    expect(isNodeBelow("20.19.0", MIN_NODE_VERSION)).toBe(true);
    expect(isNodeBelow("18.20.0", MIN_NODE_VERSION)).toBe(true);
    expect(isNodeBelow("22.13.0", "22.13.0")).toBe(false);
  });

  it("tolerates a leading v and a prerelease/build suffix", () => {
    expect(isNodeBelow("v22.12.0", MIN_NODE_VERSION)).toBe(true);
    expect(isNodeBelow("v22.13.0", MIN_NODE_VERSION)).toBe(false);
    expect(isNodeBelow("22.13.0-nightly20250101", MIN_NODE_VERSION)).toBe(false);
    expect(isNodeBelow("22.12.0-rc.1", MIN_NODE_VERSION)).toBe(true);
  });

  it("the enforced floor is 22.13.0", () => {
    expect(MIN_NODE_VERSION).toBe("22.13.0");
  });
});
