import { describe, expect, it } from "vitest";

import { runAuditInputSchema } from "../src/core/schemas.js";

describe("runAuditInputSchema", () => {
  it("accepts the devtools-mcp-oriented audit options", () => {
    const parsed = runAuditInputSchema.parse({
      url: "https://example.com",
      lightMode: true,
      includeLighthouse: true,
      includeMemory: true,
      includeConsole: true,
      includeEvaluation: true,
      analyzeInsightsCount: 3,
      launchManagedBrowser: true,
      mcpCommand: "npx",
      mcpArgs: ["-y", "chrome-devtools-mcp@latest"],
      logFile: "audits/page-audit.log"
    });

    expect(parsed.url).toBe("https://example.com");
    expect(parsed.lightMode).toBe(true);
    expect(parsed.analyzeInsightsCount).toBe(3);
    expect(parsed.launchManagedBrowser).toBe(true);
    expect(parsed.mcpArgs).toEqual(["-y", "chrome-devtools-mcp@latest"]);
    expect(parsed.logFile).toBe("audits/page-audit.log");
  });
});
