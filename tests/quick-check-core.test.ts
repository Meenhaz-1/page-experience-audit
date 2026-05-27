import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AuditArtifact } from "../src/core/types.js";
import { buildQuickCheckArtifact, renderQuickCheckHtml } from "../src/quick-check/core.js";

function createTraceFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "page-audit-trace-"));
  const tracePath = path.join(dir, "trace.json");
  writeFileSync(
    tracePath,
    JSON.stringify({
      traceEvents: [
        {
          args: { name: "CrRendererMain" },
          cat: "__metadata",
          name: "thread_name",
          ph: "M",
          pid: 101,
          tid: 202,
          ts: 0
        },
        {
          args: { data: { url: "https://match.prod.bidr.io/player.js" } },
          cat: "devtools.timeline",
          name: "FunctionCall",
          ph: "X",
          pid: 101,
          tid: 202,
          ts: 1,
          dur: 180000
        },
        {
          args: { data: { url: "https://player-frontend.cnevids.com/player/mobile.js" } },
          cat: "devtools.timeline",
          name: "FunctionCall",
          ph: "X",
          pid: 101,
          tid: 202,
          ts: 2,
          dur: 90000
        },
        {
          args: { data: { url: "https://www.vogue.com/verso/static/2880.js" } },
          cat: "devtools.timeline",
          name: "FunctionCall",
          ph: "X",
          pid: 101,
          tid: 202,
          ts: 3,
          dur: 30000
        }
      ]
    }),
    "utf8"
  );
  return tracePath;
}

function createArtifact(overrides: Partial<AuditArtifact> = {}): AuditArtifact {
  const base: AuditArtifact = {
    auditId: "audit_test",
    status: "completed_with_warnings",
    request: {
      url: "https://example.com/",
      timeoutMs: 60000,
      settleTimeMs: 5000,
      cpuThrottleRate: 4,
      deviceProfile: "iphone_16_pro",
      lightMode: false,
      aiMode: "disabled",
      outputDetail: "full",
      includeLighthouse: true,
      includeMemory: true,
      includeConsole: true,
      includeEvaluation: true,
      analyzeInsightsCount: 3,
      launchManagedBrowser: false,
      includeScrollProfile: true,
      scrollSteps: 8,
      scrollPauseMs: 750,
      mcpCommand: "npx",
      mcpArgs: [],
      browserUrl: "http://127.0.0.1:9222",
      logFile: null
    },
    environment: {
      collector: "chrome-devtools-mcp",
      emulation: "Chrome DevTools MCP with Chromium emulation (iphone_16_pro)"
    },
    navigation: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      status: "success",
      selectedPageId: 1,
      startedAt: "2026-05-26T00:00:00.000Z",
      completedAt: "2026-05-26T00:00:10.000Z"
    },
    trace: {
      tracePath: createTraceFile(),
      startTrace: { toolName: "performance_start_trace", arguments: {}, isError: false, text: "", structuredContent: {} },
      stopTrace: { toolName: "performance_stop_trace", arguments: {}, isError: false, text: "Duration: 120 ms", structuredContent: {} },
      analyzedInsights: [{ toolName: "analyze_insight", arguments: { insightName: "ThirdParties" }, isError: false, text: "", structuredContent: {} }],
      discoveredInsights: [{ name: "ThirdParties" }]
    },
    memory: {
      heapSnapshotPath: "audits/runs/audit_test/heap.heapsnapshot",
      takeHeapSnapshot: { toolName: "take_memory_snapshot", arguments: {}, isError: false, text: "", structuredContent: {} },
      summary: {
        toolName: "load_memory_snapshot",
        arguments: {},
        isError: false,
        text: "",
        structuredContent: {
          heapSnapshot: {
            stats: {
              total: 210_000_000,
              v8heap: {
                code: 45_000_000
              }
            },
            staticData: {
              nodeCount: 2_600_000
            }
          }
        }
      },
      details: null,
      classNodes: [],
      retainers: []
    },
    debugging: {
      pageSnapshot: { toolName: "take_snapshot", arguments: {}, isError: false, text: "", structuredContent: {} },
      networkRequests: { toolName: "list_network_requests", arguments: {}, isError: false, text: "GET https://doubleclick.net/foo 404", structuredContent: {} },
      evaluation: {
        toolName: "evaluate_script",
        arguments: {},
        isError: false,
        text: "",
        structuredContent: {
          domNodes: 1400,
          iframeCount: 12,
          imageCount: 25,
          eagerImagesBelowFold: 6,
          eagerIframesBelowFold: 3,
          missingLazyImages: 8,
          missingLazyIframes: 2
        }
      },
      rerenderProbe: {
        toolName: "evaluate_script",
        arguments: {},
        isError: false,
        text: "",
        structuredContent: {
          mutationCount: 420,
          changedNodeCount: 120,
          longFrameCount: 5
        }
      },
      consoleMessages: { toolName: "list_console_messages", arguments: {}, isError: false, text: "[GPT] warning", structuredContent: {} },
      consoleMessageDetails: [
        { toolName: "get_console_message", arguments: {}, isError: false, text: "Uncaught Error: boom", structuredContent: {} },
        { toolName: "get_console_message", arguments: {}, isError: false, text: "[GPT] PubAdsService.getTargeting is deprecated", structuredContent: {} }
      ],
      lighthouse: {
        toolName: "lighthouse_audit",
        arguments: {},
        isError: false,
        text: "",
        structuredContent: {
          lighthouseResult: {
            summary: {
              timing: {
                total: 17000
              }
            }
          }
        }
      }
    },
    scrollProfile: {
      attempted: true,
      executionMethod: "press_key_with_snapshot",
      completedSteps: 8,
      traceCapturedDuringScroll: true,
      samples: [
        { step: 1, domNodes: 1000, usedJsHeapBytes: 120_000_000, timestamp: 1 },
        { step: 8, domNodes: 1600, usedJsHeapBytes: 240_000_000, timestamp: 2 }
      ],
      peakUsedJsHeapBytes: 240_000_000,
      domNodeGrowth: 320,
      maxDomNodes: 1600,
      cumulativeLayoutShift: 1
    },
    derivedSignals: {
      insightCount: 1,
      consoleMessageCount: 2,
      memoryAnalysisIncluded: true,
      lighthouseIncluded: true,
      scrollProfileIncluded: true,
      liveDomElementCount: 1400,
      heapGraphNodeCount: 2_600_000
    },
    warnings: [],
    aiOutput: null,
    createdAt: "2026-05-26T00:00:11.000Z"
  };

  return {
    ...base,
    ...overrides,
    debugging: {
      ...base.debugging,
      ...(overrides.debugging ?? {})
    },
    trace: {
      ...base.trace,
      ...(overrides.trace ?? {})
    },
    memory: overrides.memory === undefined ? base.memory : overrides.memory,
    scrollProfile: overrides.scrollProfile === undefined ? base.scrollProfile : overrides.scrollProfile,
    derivedSignals: {
      ...base.derivedSignals,
      ...(overrides.derivedSignals ?? {})
    }
  };
}

describe("buildQuickCheckArtifact", () => {
  it("builds the user journey perspective layer and renders it into HTML", () => {
    const artifact = buildQuickCheckArtifact(createArtifact(), { url: "https://example.com/" });
    const html = renderQuickCheckHtml(artifact);

    expect(artifact.userJourneyImpact).toHaveLength(5);
    expect(artifact.decisionIssues.length).toBeGreaterThan(0);
    expect(artifact.decisionSummary).toContain("P");
    expect(artifact.commonViewpointSummary).toContain("most affected stage");
    expect(artifact.criticalAlerts.length).toBeGreaterThan(0);
    expect(artifact.decisionIssues[0]?.priority).toBeTruthy();
    expect(artifact.thirdPartyCpuImpact.available).toBe(true);
    expect(artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs).toBeGreaterThan(0);
    expect(artifact.thirdPartyCpuImpact.topVendor).toBeTruthy();
    expect(artifact.userJourneyImpact[0]?.name).toBe("Page Opens Reliably");
    expect(artifact.userJourneyImpact[4]?.name).toBe("Session Stays Stable");
    expect(artifact.userJourneyImpact.some((lens) => lens.status === "Needs Attention" || lens.status === "Blocked")).toBe(true);
    expect(html).toContain("Decision Layer");
    expect(html).toContain("Expand Decision Layer");
    expect(html).toContain("CRITICAL UX FAILURE");
    expect(html).toContain("Journey Stage");
    expect(html).toContain("Third-Party CPU Impact");
    expect(html).toContain("Main-Thread Time");
    expect(html).toContain("User Journey Perspective");
    expect(html).toContain("Expand User Journey Perspective");
    expect(html).toContain("Expand Page Opens Reliably");
  });

  it("extracts evaluation values from JSON embedded in a tool message", () => {
    const artifact = buildQuickCheckArtifact(
      createArtifact({
        debugging: {
          ...createArtifact().debugging,
          evaluation: {
            toolName: "evaluate_script",
            arguments: {},
            isError: false,
            text: "",
            structuredContent: {
              message:
                "```json\n{\"domNodes\":901,\"iframeCount\":13,\"imageCount\":31,\"eagerImagesBelowFold\":4,\"eagerIframesBelowFold\":1,\"missingLazyImages\":3,\"missingLazyIframes\":2}\n```"
            }
          }
        }
      }),
      { url: "https://example.com/" }
    );

    expect(artifact.keyMetrics.domNodeCount).toBe(901);
    expect(artifact.keyMetrics.iframeCount).toBe(13);
    expect(artifact.keyMetrics.imageCount).toBe(31);
    expect(artifact.keyMetrics.eagerIframesBelowFold).toBe(1);
  });

  it("degrades lens confidence without forcing all partial-data runs into failure", () => {
    const artifact = buildQuickCheckArtifact(
      createArtifact({
        trace: {
          ...createArtifact().trace,
          startTrace: { toolName: "performance_start_trace", arguments: {}, isError: true, text: "failed", structuredContent: null },
          stopTrace: { toolName: "performance_stop_trace", arguments: {}, isError: true, text: "failed", structuredContent: null },
          analyzedInsights: [],
          discoveredInsights: []
        },
        memory: null,
        debugging: {
          ...createArtifact().debugging,
          evaluation: { toolName: "evaluate_script", arguments: {}, isError: true, text: "failed", structuredContent: null },
          rerenderProbe: null
        },
        scrollProfile: null
      }),
      { url: "https://example.com/" }
    );

    const openLens = artifact.userJourneyImpact.find((lens) => lens.name === "Page Opens Reliably");
    const sessionLens = artifact.userJourneyImpact.find((lens) => lens.name === "Session Stays Stable");

    expect(openLens?.aiSummary).toContain("partial");
    expect(sessionLens?.aiSummary).toContain("partial");
    expect(openLens?.status).not.toBe("Blocked");
  });
});
