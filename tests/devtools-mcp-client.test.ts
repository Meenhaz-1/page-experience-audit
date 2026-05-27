import { describe, expect, it } from "vitest";

import {
  browserVersionEndpoint,
  deriveNavigationStatus,
  extractConsoleMessageIds,
  extractHeapClassIds,
  extractHeapNodeIds,
  extractInsightReferences,
  extractPageId,
  isBrowserConnectionFailureText,
  probeBrowserEndpoint
} from "../src/core/devtools-mcp-client.js";

describe("devtools mcp helpers", () => {
  it("extracts page ids from text", () => {
    expect(
      extractPageId({
        toolName: "new_page",
        arguments: {},
        isError: false,
        text: 'Created page with pageId: 7',
        structuredContent: null
      })
    ).toBe(7);
  });

  it("extracts insight references from trace output", () => {
    const insights = extractInsightReferences({
      toolName: "performance_stop_trace",
      arguments: {},
      isError: false,
      text: 'insightSetId: set_1 insightName: LCPBreakdown\ninsightSetId: set_1 insightName: DocumentLatency',
      structuredContent: null
    });

    expect(insights).toEqual([
      { insightSetId: "set_1", insightName: "LCPBreakdown" },
      { insightSetId: "set_1", insightName: "DocumentLatency" }
    ]);
  });

  it("extracts console, class, and node ids", () => {
    expect(
      extractConsoleMessageIds(
        {
          toolName: "list_console_messages",
          arguments: {},
          isError: false,
          text: "msgid: 1\nmsgid: 2",
          structuredContent: null
        },
        10
      )
    ).toEqual([1, 2]);

    expect(
      extractHeapClassIds(
        {
          toolName: "get_heapsnapshot_details",
          arguments: {},
          isError: false,
          text: "id: 101\nid: 202",
          structuredContent: null
        },
        10
      )
    ).toEqual([101, 202]);

    expect(
      extractHeapNodeIds(
        {
          toolName: "get_heapsnapshot_class_nodes",
          arguments: {},
          isError: false,
          text: "nodeId: 303\nnodeId: 404",
          structuredContent: null
        },
        10
      )
    ).toEqual([303, 404]);
  });

  it("derives success navigation status", () => {
    expect(
      deriveNavigationStatus(
        {
          toolName: "new_page",
          arguments: {},
          isError: false,
          text: "",
          structuredContent: null
        },
        "https://example.com/"
      )
    ).toBe("success");
  });

  it("builds and probes the browser endpoint", async () => {
    expect(browserVersionEndpoint("http://127.0.0.1:9222")).toBe(
      "http://127.0.0.1:9222/json/version"
    );

    const healthy = await probeBrowserEndpoint(
      "http://127.0.0.1:9222",
      (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc"
          })
        })) as typeof fetch
    );

    expect(healthy).toMatchObject({
      ok: true,
      status: 200,
      error: null
    });

    const unhealthy = await probeBrowserEndpoint(
      "http://127.0.0.1:9222",
      (async () => {
        throw new Error("fetch failed");
      }) as typeof fetch
    );

    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.error).toContain("fetch failed");
  });

  it("detects browser connection failure text", () => {
    expect(
      isBrowserConnectionFailureText(
        "Could not connect to Chrome. Cause: Failed to fetch browser webSocket URL from http://127.0.0.1:9222/json/version: fetch failed"
      )
    ).toBe(true);
    expect(isBrowserConnectionFailureText("No page found")).toBe(false);
  });
});
