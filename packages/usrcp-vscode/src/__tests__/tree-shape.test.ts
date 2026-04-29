import { describe, expect, it } from "vitest";

import type { UsrcpFact } from "../mcp-client.js";
import {
  previewValue,
  shapeDomainNodes,
  shapeFactNodes,
} from "../tree-shape.js";

const fact = (
  domain: string,
  namespace: string,
  key: string,
  value: unknown,
): UsrcpFact => ({ domain, namespace, key, value });

describe("shapeDomainNodes", () => {
  it("sorts domains alphabetically and counts facts per domain", () => {
    const facts = new Map<string, UsrcpFact[]>([
      ["coding", [fact("coding", "ns", "k1", "v"), fact("coding", "ns", "k2", "v")]],
      ["writing", [fact("writing", "ns", "k", "v")]],
    ]);
    const nodes = shapeDomainNodes(["writing", "coding"], facts);
    expect(nodes.map((n) => n.domain)).toEqual(["coding", "writing"]);
    expect(nodes.map((n) => n.factCount)).toEqual([2, 1]);
  });

  it("reports zero facts for a domain that has events but no facts", () => {
    const nodes = shapeDomainNodes(["coding"], new Map());
    expect(nodes).toEqual([{ kind: "domain", domain: "coding", factCount: 0 }]);
  });
});

describe("shapeFactNodes", () => {
  it("returns an EmptyNode when there are no facts", () => {
    const nodes = shapeFactNodes("coding", []);
    expect(nodes).toEqual([{ kind: "empty", message: "(no facts in this domain)" }]);
  });

  it("sorts facts by namespace then key and renders namespace/key labels", () => {
    const nodes = shapeFactNodes("coding", [
      fact("coding", "z-ns", "k", 1),
      fact("coding", "a-ns", "b", 2),
      fact("coding", "a-ns", "a", 3),
    ]);
    expect(nodes.map((n) => (n.kind === "fact" ? n.label : ""))).toEqual([
      "a-ns/a",
      "a-ns/b",
      "z-ns/k",
    ]);
  });

  it("includes a json-stringified tooltip and a short description preview", () => {
    const [node] = shapeFactNodes("coding", [
      fact("coding", "ns", "k", { hello: "world" }),
    ]);
    if (node.kind !== "fact") throw new Error("expected fact node");
    expect(node.tooltip).toContain("hello");
    expect(node.description).toBe("{...}");
  });
});

describe("previewValue", () => {
  it("renders short strings as-is", () => {
    expect(previewValue("short")).toBe("short");
  });
  it("truncates strings over 60 chars with ellipsis", () => {
    const long = "a".repeat(80);
    const out = previewValue(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("...")).toBe(true);
  });
  it("renders numbers and booleans via String()", () => {
    expect(previewValue(42)).toBe("42");
    expect(previewValue(true)).toBe("true");
  });
  it("renders arrays as count placeholder", () => {
    expect(previewValue([1, 2, 3])).toBe("[3 items]");
  });
  it("renders objects as {...}", () => {
    expect(previewValue({ a: 1 })).toBe("{...}");
  });
  it("renders null/undefined as empty string", () => {
    expect(previewValue(null)).toBe("");
    expect(previewValue(undefined)).toBe("");
  });
});
