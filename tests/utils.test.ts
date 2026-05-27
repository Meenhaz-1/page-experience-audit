import { describe, expect, it } from "vitest";

import { createAuditId, normalizeUrl } from "../src/core/utils.js";

describe("utils", () => {
  it("normalizes URLs", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("creates stable audit ids for the same url prefix format", () => {
    const first = createAuditId("https://example.com/");
    const second = createAuditId("https://example.com/");

    expect(first.startsWith("audit_")).toBe(true);
    expect(second.startsWith("audit_")).toBe(true);
    expect(first.split("_").at(-1)).toBe(second.split("_").at(-1));
  });
});
