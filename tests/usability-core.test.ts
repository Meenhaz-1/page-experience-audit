import { describe, expect, it } from "vitest";

import type { AuditArtifact } from "../src/core/types.js";
import { buildUsabilityArtifact } from "../src/usability/core.js";

function createArtifact(): AuditArtifact {
  return {
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
      tracePath: "audits/audit_test.trace.json",
      startTrace: { toolName: "performance_start_trace", arguments: {}, isError: false, text: "", structuredContent: {} },
      stopTrace: { toolName: "performance_stop_trace", arguments: {}, isError: false, text: "", structuredContent: {} },
      analyzedInsights: [],
      discoveredInsights: []
    },
    memory: {
      heapSnapshotPath: "audits/audit_test.heapsnapshot",
      takeHeapSnapshot: { toolName: "take_memory_snapshot", arguments: {}, isError: false, text: "", structuredContent: {} },
      summary: {
        toolName: "load_memory_snapshot",
        arguments: {},
        isError: false,
        text: "",
        structuredContent: {
          heapSnapshot: {
            stats: {
              total: 200_000_000,
              v8heap: {
                code: 40_000_000
              }
            },
            staticData: {
              nodeCount: 2_000_000
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
      networkRequests: { toolName: "list_network_requests", arguments: {}, isError: false, text: "net::ERR_ABORTED", structuredContent: {} },
      evaluation: { toolName: "evaluate_script", arguments: {}, isError: false, text: "", structuredContent: { domNodes: 500 } },
      rerenderProbe: { toolName: "evaluate_script", arguments: {}, isError: false, text: "", structuredContent: { mutationCount: 12 } },
      consoleMessages: { toolName: "list_console_messages", arguments: {}, isError: false, text: "", structuredContent: {} },
      consoleMessageDetails: [
        { toolName: "get_console_message", arguments: {}, isError: false, text: "Uncaught Error: boom", structuredContent: {} }
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
                total: 6000
              },
              audits: {
                failed: 4
              },
              scores: [{ id: "accessibility", score: 0.91 }]
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
      samples: [],
      peakUsedJsHeapBytes: 180_000_000,
      domNodeGrowth: 120,
      maxDomNodes: 620,
      cumulativeLayoutShift: 0.12
    },
    derivedSignals: {
      insightCount: 0,
      consoleMessageCount: 1,
      memoryAnalysisIncluded: true,
      lighthouseIncluded: true,
      scrollProfileIncluded: true,
      liveDomElementCount: 500,
      heapGraphNodeCount: 2_000_000
    },
    warnings: [
      { code: "AI_DISABLED", message: "AI synthesis was disabled for this audit run.", recoverable: true }
    ],
    aiOutput: null,
    createdAt: "2026-05-26T00:00:11.000Z"
  };
}

describe("buildUsabilityArtifact", () => {
  it("extracts usability-focused categories and top-level hits", () => {
    const artifact = buildUsabilityArtifact(createArtifact(), { url: "https://example.com/" });

    expect(artifact.loadExperience.metrics[1]?.value).toBe(6000);
    expect(artifact.scrollExperience.metrics[2]?.value).toBe(120);
    expect(artifact.memoryPressure.metrics[1]?.value).toBeCloseTo(190.735, 2);
    expect(artifact.accessibility.metrics[0]?.value).toBe(91);
    expect(artifact.topLevelHits[0]?.area).toBe("Scroll Stability");
    expect(artifact.reliability.findings.join(" ")).toContain("console/runtime error");
  });
});
