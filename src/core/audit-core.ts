import fs from "node:fs/promises";
import path from "node:path";

import { createAiDisabledWarning, type AiProvider } from "./ai.js";
import { AuditLogger, type AuditProgressSink } from "./audit-logger.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  buildEmulationArgs,
  ChromeDevtoolsMcpClient,
  deriveNavigationStatus,
  extractConsoleMessageIds,
  extractFinalUrl,
  extractHeapClassIds,
  extractHeapNodeIds,
  extractInsightReferences,
  extractPageId,
  extractPageIds,
  getDeviceProfile,
  heapSnapshotPath,
  isBrowserConnectionFailureText,
  traceFilePath
} from "./devtools-mcp-client.js";
import { withAuditDefaults } from "./defaults.js";
import type {
  AuditArtifact,
  AuditRequest,
  AuditStatus,
  AuditWarning,
  DebuggingArtifacts,
  DevtoolsToolArtifact,
  MemoryArtifacts,
  ScrollProfile,
  ScrollProfileSample,
  TraceArtifacts
} from "./types.js";
import {
  auditRunDir,
  createAuditId,
  defaultAuditLogPath,
  normalizeUrl,
  sleep
} from "./utils.js";

export interface AuditEngineDependencies {
  store?: ArtifactStore;
  aiProvider?: AiProvider;
  progressSink?: AuditProgressSink;
}

export class AuditEngine {
  private readonly store: ArtifactStore;
  private readonly aiProvider?: AiProvider;
  private readonly progressSink?: AuditProgressSink;

  constructor(deps: AuditEngineDependencies = {}) {
    this.store = deps.store ?? new ArtifactStore();
    this.aiProvider = deps.aiProvider;
    this.progressSink = deps.progressSink;
  }

  async run(request: AuditRequest): Promise<AuditArtifact> {
    const normalizedUrl = normalizeUrl(request.url);
    const normalizedRequest = withAuditDefaults({ ...request, url: normalizedUrl });
    const auditId = createAuditId(normalizedUrl);
    const warnings: AuditWarning[] = [];
    const logFile = normalizedRequest.logFile || defaultAuditLogPath(auditId);
    const runDir = auditRunDir("audits", auditId);
    const logger = new AuditLogger(logFile, this.progressSink);

    await fs.mkdir(runDir, { recursive: true });
    await logger.log("audit:start", {
      auditId,
      url: normalizedUrl,
      aiMode: normalizedRequest.aiMode
    });

    const mcpClient = new ChromeDevtoolsMcpClient({
      command: normalizedRequest.mcpCommand,
      args: buildRuntimeMcpArgs(normalizedRequest),
      cwd: process.cwd(),
      onLog: (message, extra) => logger.log(message, extra)
    });

    try {
      await mcpClient.connect();
      await logger.log("mcp:connected", { command: normalizedRequest.mcpCommand });
      const availableTools = await mcpClient.listTools();
      await logger.log("mcp:tools", { availableTools });
    } catch (error) {
      await logger.log("mcp:connect_failed", { error: String(error) });
      throw new Error(`Failed to connect to chrome-devtools-mcp: ${String(error)}`);
    }

    try {
      const deviceProfile = getDeviceProfile(normalizedRequest.deviceProfile);
      const startedAt = new Date().toISOString();

      const {
        navigationArtifact,
        pageId: initialPageId,
        hasSelectedPageContext: initialSelectedPageContext
      } = await openAuditPage(
        mcpClient,
        normalizedUrl,
        normalizedRequest.timeoutMs,
        warnings,
        logger
      );

      let pageId = initialPageId;
      let hasSelectedPageContext = initialSelectedPageContext;

      const pageScopedArgs = pageId !== null ? { pageId } : {};
      const canRunPageScopedTools = pageId !== null || hasSelectedPageContext;
      const managedMode = normalizedRequest.launchManagedBrowser;

      const emulate = await requireSuccessfulTool(
        mcpClient.callTool(
          "emulate",
          {
            ...pageScopedArgs,
            ...buildEmulationArgs(deviceProfile, normalizedRequest.cpuThrottleRate)
          }
        ),
        warnings
      );

      const pageSnapshot = await optionalTool(
        mcpClient,
        "take_snapshot",
        pageScopedArgs,
        warnings
      );

      const networkRequests = await optionalTool(
        mcpClient,
        "list_network_requests",
        pageScopedArgs,
        warnings
      );

      const evaluation = normalizedRequest.includeEvaluation
        ? await optionalTool(
            mcpClient,
            "evaluate_script",
            {
              ...pageScopedArgs,
              function: `() => ({
                title: document.title,
                url: location.href,
                domNodes: document.getElementsByTagName("*").length,
                iframeCount: document.getElementsByTagName("iframe").length,
                imageCount: document.images.length,
                readyState: document.readyState,
                bodyTextLength: document.body?.innerText?.length ?? 0,
                ...(() => {
                  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                  const images = Array.from(document.images);
                  const iframes = Array.from(document.getElementsByTagName("iframe"));
                  const isBelowFold = (element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.top > viewportHeight;
                  };
                  const isEager = (element) => {
                    const loading = (element.getAttribute("loading") || "").toLowerCase();
                    return loading !== "lazy";
                  };
                  const eagerImagesBelowFold = images.filter((image) => isBelowFold(image) && isEager(image)).length;
                  const eagerIframesBelowFold = iframes.filter((iframe) => isBelowFold(iframe) && isEager(iframe)).length;
                  const missingLazyImages = images.filter((image) => {
                    const loading = (image.getAttribute("loading") || "").toLowerCase();
                    return !loading;
                  }).length;
                  const missingLazyIframes = iframes.filter((iframe) => {
                    const loading = (iframe.getAttribute("loading") || "").toLowerCase();
                    return !loading;
                  }).length;
                  return {
                    eagerImagesBelowFold,
                    eagerIframesBelowFold,
                    missingLazyImages,
                    missingLazyIframes,
                  };
                })(),
              })`
            },
            warnings
          )
        : null;
      const rerenderProbe = normalizedRequest.includeEvaluation
        ? await optionalTool(
            mcpClient,
            "evaluate_script",
            {
              ...pageScopedArgs,
              function: `async () => {
                const mutationStats = {
                  mutationCount: 0,
                  changedNodeCount: 0,
                  childListMutationCount: 0,
                  attributeMutationCount: 0,
                  characterDataMutationCount: 0,
                };
                const changedNodes = new Set();
                const observer = new MutationObserver((mutations) => {
                  mutationStats.mutationCount += mutations.length;
                  for (const mutation of mutations) {
                    if (mutation.type === "childList") {
                      mutationStats.childListMutationCount += 1;
                    } else if (mutation.type === "attributes") {
                      mutationStats.attributeMutationCount += 1;
                    } else if (mutation.type === "characterData") {
                      mutationStats.characterDataMutationCount += 1;
                    }

                    if (mutation.target) {
                      changedNodes.add(mutation.target);
                    }
                    mutation.addedNodes?.forEach((node) => changedNodes.add(node));
                    mutation.removedNodes?.forEach((node) => changedNodes.add(node));
                  }
                  mutationStats.changedNodeCount = changedNodes.size;
                });

                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
                const frameDurations = [];
                let previousFrameTime = performance.now();

                const sampleFrames = async (count) => {
                  for (let index = 0; index < count; index += 1) {
                    await raf();
                    const currentFrameTime = performance.now();
                    frameDurations.push(currentFrameTime - previousFrameTime);
                    previousFrameTime = currentFrameTime;
                  }
                };

                const before = {
                  domNodes: document.getElementsByTagName("*").length,
                  bodyTextLength: document.body?.innerText?.length ?? 0,
                  scrollY: window.scrollY,
                };

                observer.observe(document.documentElement, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                  characterData: true,
                });

                await raf();
                await wait(350);
                await sampleFrames(8);
                await wait(350);
                observer.disconnect();

                const after = {
                  domNodes: document.getElementsByTagName("*").length,
                  bodyTextLength: document.body?.innerText?.length ?? 0,
                  scrollY: window.scrollY,
                };

                return {
                  observationWindowMs: 700,
                  ...mutationStats,
                  domNodesBefore: before.domNodes,
                  domNodesAfter: after.domNodes,
                  bodyTextLengthBefore: before.bodyTextLength,
                  bodyTextLengthAfter: after.bodyTextLength,
                  scrollYBefore: before.scrollY,
                  scrollYAfter: after.scrollY,
                  maxFrameDurationMs: frameDurations.length ? Math.max(...frameDurations) : null,
                  longFrameCount: frameDurations.filter((duration) => duration >= 50).length,
                };
              }`
            },
            warnings
          )
        : null;

      let scrollProfile: ScrollProfile | null = null;

      const consoleMessages = normalizedRequest.includeConsole
        ? await optionalTool(mcpClient, "list_console_messages", pageScopedArgs, warnings)
        : null;
      const consoleMessageDetails: DevtoolsToolArtifact[] = [];
      if (consoleMessages) {
        for (const msgid of extractConsoleMessageIds(consoleMessages, 5)) {
          consoleMessageDetails.push(
            await requireSuccessfulTool(mcpClient.callTool("get_console_message", { msgid }), warnings)
          );
        }
      }

      const lightweightCoverageHealthy =
        isSuccessfulArtifact(pageSnapshot) ||
        isSuccessfulArtifact(networkRequests) ||
        isSuccessfulArtifact(consoleMessages) ||
        isSuccessfulArtifact(evaluation);

      if (managedMode && !lightweightCoverageHealthy) {
        warnings.push({
          code: "MCP_TOOL_FAILED",
          message:
            "Managed browser mode did not produce lightweight page evidence, so trace, memory, and Lighthouse phases were skipped to avoid cascading timeouts.",
          recoverable: true
        });
      }

      const tracePath = traceFilePath(auditId);
      await fs.mkdir(path.dirname(tracePath), { recursive: true });
      let startTrace: DevtoolsToolArtifact = skippedArtifact(
        "performance_start_trace",
        "Skipped because the managed browser preflight phase was not healthy enough."
      );
      let stopTrace: DevtoolsToolArtifact = skippedArtifact(
        "performance_stop_trace",
        "Skipped because the managed browser preflight phase was not healthy enough."
      );
      let discoveredInsights: TraceArtifacts["discoveredInsights"] = [];
      const analyzedInsights: DevtoolsToolArtifact[] = [];

      const shouldRunTracePhase = !managedMode || lightweightCoverageHealthy;
      if (shouldRunTracePhase) {
        startTrace = await requireSuccessfulTool(
          mcpClient.callTool("performance_start_trace", {
            autoStop: false,
            reload: false,
            filePath: tracePath
          }, normalizedRequest.timeoutMs + 30_000),
          warnings
        );

        if (isSuccessfulArtifact(startTrace)) {
          if (normalizedRequest.includeScrollProfile) {
            scrollProfile = canRunPageScopedTools
              ? await buildScrollProfile(
                  mcpClient,
                  pageScopedArgs,
                  normalizedRequest.scrollSteps,
                  normalizedRequest.scrollPauseMs,
                  warnings,
                  logger
                )
              : await buildKeypressScrollProfile(
                  mcpClient,
                  normalizedRequest.scrollSteps,
                  normalizedRequest.scrollPauseMs,
                  warnings,
                  logger
                );
          } else {
            await sleep(normalizedRequest.settleTimeMs);
          }

          stopTrace = await requireSuccessfulTool(
            mcpClient.callTool("performance_stop_trace", {
              filePath: tracePath
            }, normalizedRequest.timeoutMs + 30_000),
            warnings
          );

          if (isSuccessfulArtifact(stopTrace)) {
            scrollProfile = await enrichScrollProfileFromTrace(
              scrollProfile,
              tracePath,
              logger
            );
            discoveredInsights = extractInsightReferences(stopTrace);

            if (discoveredInsights.length === 0) {
              warnings.push({
                code: "INSIGHT_ANALYSIS_SKIPPED",
                message:
                  "Trace output did not expose structured insight identifiers, so no detailed insight drill-downs were run.",
                recoverable: true
              });
            } else {
              for (const insight of chooseInsightsForAnalysis(
                discoveredInsights,
                normalizedRequest.analyzeInsightsCount
              )) {
                analyzedInsights.push(
                  await requireSuccessfulTool(
                    mcpClient.callTool("performance_analyze_insight", {
                      insightSetId: insight.insightSetId,
                      insightName: insight.insightName
                    }),
                    warnings
                  )
                );
              }
            }
          }
        }
      }

      const tracePhaseHealthy = isSuccessfulArtifact(startTrace) && isSuccessfulArtifact(stopTrace);

      let memory: MemoryArtifacts | null = null;
      if (normalizedRequest.includeMemory && (!managedMode || tracePhaseHealthy)) {
        const availableTools = await mcpClient.listTools();
        const snapshotPath = heapSnapshotPath(auditId);
        await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
        const takeSnapshotTool = availableTools.includes("take_heapsnapshot")
          ? "take_heapsnapshot"
          : availableTools.includes("take_memory_snapshot")
            ? "take_memory_snapshot"
            : null;
        const summaryTool = availableTools.includes("get_heapsnapshot_summary")
          ? "get_heapsnapshot_summary"
          : availableTools.includes("load_memory_snapshot")
            ? "load_memory_snapshot"
            : null;
        const detailsTool = availableTools.includes("get_heapsnapshot_details")
          ? "get_heapsnapshot_details"
          : availableTools.includes("get_memory_snapshot_details")
            ? "get_memory_snapshot_details"
            : null;
        const classNodesTool = availableTools.includes("get_heapsnapshot_class_nodes")
          ? "get_heapsnapshot_class_nodes"
          : availableTools.includes("get_nodes_by_class")
            ? "get_nodes_by_class"
            : null;
        const retainersTool = availableTools.includes("get_heapsnapshot_retainers")
          ? "get_heapsnapshot_retainers"
          : null;

        if (!takeSnapshotTool || !summaryTool || !detailsTool) {
          warnings.push({
            code: "MEMORY_ANALYSIS_SKIPPED",
            message: "The connected chrome-devtools-mcp server does not expose the expected memory tools for this run.",
            recoverable: true
          });
        } else {
          const takeHeapSnapshot = await optionalTool(
            mcpClient,
            takeSnapshotTool,
            { filePath: snapshotPath },
            warnings
          );

          if (takeHeapSnapshot) {
            const summary = await optionalTool(
              mcpClient,
              summaryTool,
              { filePath: snapshotPath },
              warnings
            );
            const details = await optionalTool(
              mcpClient,
              detailsTool,
              { filePath: snapshotPath, pageSize: 20 },
              warnings
            );
            const classNodes: DevtoolsToolArtifact[] = [];
            const retainers: DevtoolsToolArtifact[] = [];

            if (details && classNodesTool) {
              for (const id of extractHeapClassIds(details, 3)) {
                classNodes.push(
                  await requireSuccessfulTool(
                    mcpClient.callTool(classNodesTool, {
                      filePath: snapshotPath,
                      id,
                      pageSize: 10
                    }),
                    warnings
                  )
                );
              }
            }

            for (const artifact of classNodes) {
              if (!retainersTool) {
                break;
              }
              for (const nodeId of extractHeapNodeIds(artifact, 2)) {
                retainers.push(
                  await requireSuccessfulTool(
                    mcpClient.callTool(retainersTool, {
                      filePath: snapshotPath,
                      nodeId,
                      pageSize: 10
                    }),
                    warnings
                  )
                );
              }
            }

            memory = {
              heapSnapshotPath: snapshotPath,
              takeHeapSnapshot,
              summary,
              details,
              classNodes,
              retainers
            };
          } else {
            warnings.push({
              code: "MEMORY_ANALYSIS_SKIPPED",
              message: "Heap snapshot capture failed, so memory drill-down tools were skipped.",
              recoverable: true
            });
          }
        }
      } else if (normalizedRequest.includeMemory && managedMode && !tracePhaseHealthy) {
        warnings.push({
          code: "MEMORY_ANALYSIS_SKIPPED",
          message:
            "Managed browser mode skipped memory analysis because the trace phase was not healthy enough.",
          recoverable: true
        });
      }

      const finalUrl = extractFinalUrl(evaluation ?? navigationArtifact);

      const lighthouse = normalizedRequest.includeLighthouse && (!managedMode || tracePhaseHealthy)
        ? await optionalTool(
            mcpClient,
            "lighthouse_audit",
            {
              ...pageScopedArgs,
              device: "mobile",
              mode: "snapshot",
              outputDirPath: runDir
            },
            warnings
          )
        : null;

      if (normalizedRequest.includeLighthouse && managedMode && !tracePhaseHealthy) {
        warnings.push({
          code: "MCP_TOOL_FAILED",
          message:
            "Managed browser mode skipped Lighthouse because the trace phase was not healthy enough.",
          recoverable: true
        });
      }

      let artifact: AuditArtifact = {
        auditId,
        status: "completed",
        request: {
          url: normalizedUrl,
          timeoutMs: normalizedRequest.timeoutMs,
          settleTimeMs: normalizedRequest.settleTimeMs,
          cpuThrottleRate: normalizedRequest.cpuThrottleRate,
          deviceProfile: normalizedRequest.deviceProfile,
          lightMode: normalizedRequest.lightMode,
          aiMode: normalizedRequest.aiMode,
          outputDetail: normalizedRequest.outputDetail,
          includeLighthouse: normalizedRequest.includeLighthouse,
          includeMemory: normalizedRequest.includeMemory,
          includeConsole: normalizedRequest.includeConsole,
          includeEvaluation: normalizedRequest.includeEvaluation,
          analyzeInsightsCount: normalizedRequest.analyzeInsightsCount,
          launchManagedBrowser: normalizedRequest.launchManagedBrowser,
          includeScrollProfile: normalizedRequest.includeScrollProfile,
          scrollSteps: normalizedRequest.scrollSteps,
          scrollPauseMs: normalizedRequest.scrollPauseMs,
          mcpCommand: normalizedRequest.mcpCommand,
          mcpArgs: buildRuntimeMcpArgs(normalizedRequest),
          browserUrl: normalizedRequest.browserUrl || null,
          logFile
        },
        environment: {
          collector: "chrome-devtools-mcp",
          emulation: describeEmulationMode(managedMode, normalizedRequest.deviceProfile, normalizedRequest.lightMode)
        },
        navigation: {
          requestedUrl: normalizedUrl,
          finalUrl,
          status: deriveNavigationStatus(navigationArtifact, finalUrl),
          selectedPageId: pageId,
          startedAt,
          completedAt: new Date().toISOString()
        },
        trace: {
          tracePath,
          startTrace,
          stopTrace,
          analyzedInsights,
          discoveredInsights
        } satisfies TraceArtifacts,
        memory,
        debugging: {
          pageSnapshot,
          networkRequests,
          evaluation,
          rerenderProbe,
          consoleMessages,
          consoleMessageDetails,
          lighthouse
        } satisfies DebuggingArtifacts,
        scrollProfile,
        derivedSignals: {
          insightCount: discoveredInsights.length,
          consoleMessageCount: consoleMessages ? extractConsoleMessageIds(consoleMessages, 1000).length : null,
          memoryAnalysisIncluded: memory !== null,
          lighthouseIncluded: lighthouse !== null,
          scrollProfileIncluded: scrollProfile !== null,
          liveDomElementCount: extractLiveDomElementCount(evaluation, scrollProfile),
          heapGraphNodeCount: extractHeapGraphNodeCount(memory)
        },
        warnings,
        aiOutput: null,
        createdAt: new Date().toISOString()
      };

      if (normalizedRequest.aiMode === "disabled") {
        artifact.warnings.push(createAiDisabledWarning());
      } else if (this.aiProvider) {
        try {
          await logger.log("ai:start", { mode: normalizedRequest.aiMode });
          artifact.aiOutput = await this.aiProvider.analyze(artifact, normalizedRequest.aiMode);
          await logger.log("ai:end", {
            mode: normalizedRequest.aiMode,
            provider: artifact.aiOutput.provider,
            model: artifact.aiOutput.model
          });
        } catch (error) {
          await logger.log("ai:failed", { error: String(error) });
          artifact.warnings.push({
            code: "AI_FAILED",
            message: `AI synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
            recoverable: true
          });
        }
      } else {
        artifact.warnings.push({
          code: "AI_FAILED",
          message: "AI synthesis was requested but no AI provider was configured.",
          recoverable: true
        });
      }

      artifact.status = deriveStatus(artifact.warnings);

      try {
        await this.store.persist(artifact);
        await logger.log("audit:persisted", { auditId, status: artifact.status });
      } catch (error) {
        await logger.log("audit:persist_failed", { error: String(error) });
        artifact.warnings.push({
          code: "PERSISTENCE_FAILED",
          message: `Persisting the audit artifact failed: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true
        });
        artifact.status = deriveStatus(artifact.warnings);
      }

      await logger.log("audit:end", { auditId, status: artifact.status, warningCount: warnings.length });
      return artifact;
    } finally {
      await logger.log("mcp:closing");
      await mcpClient.close().catch(() => undefined);
    }
  }

  async get(auditId: string): Promise<AuditArtifact | null> {
    return this.store.get(auditId);
  }
}

async function requireSuccessfulTool(
  promise: Promise<DevtoolsToolArtifact>,
  warnings: AuditWarning[]
): Promise<DevtoolsToolArtifact> {
  try {
    const result = await promise;
    if (result.isError) {
      warnings.push({
        code: isBrowserConnectionFailureText(result.text) ? "MCP_CONNECTION_FAILED" : "MCP_TOOL_FAILED",
        message: `${result.toolName} reported an error: ${result.text || "No additional details were returned."}`,
        recoverable: true
      });
    }
    if (result.structuredContent == null) {
      warnings.push({
        code: "MCP_STRUCTURED_CONTENT_UNAVAILABLE",
        message: `${result.toolName} did not return structured content; text output parsing was used instead.`,
        recoverable: true
      });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      code: isBrowserConnectionFailureText(message) ? "MCP_CONNECTION_FAILED" : "MCP_TOOL_FAILED",
      message: `Calling a chrome-devtools-mcp tool failed: ${message}`,
      recoverable: true
    });
    throw error;
  }
}

async function optionalTool(
  client: ChromeDevtoolsMcpClient,
  toolName: string,
  args: Record<string, unknown>,
  warnings: AuditWarning[]
): Promise<DevtoolsToolArtifact | null> {
  try {
    return await requireSuccessfulTool(client.callTool(toolName, args), warnings);
  } catch {
    return null;
  }
}

function deriveStatus(warnings: AuditWarning[]): AuditStatus {
  return warnings.length > 0 ? "completed_with_warnings" : "completed";
}

function chooseInsightsForAnalysis(
  discoveredInsights: { insightSetId: string; insightName: string }[],
  requestedCount: number
): { insightSetId: string; insightName: string }[] {
  const priorities = [
    "DOMSize",
    "ThirdParties",
    "ForcedReflow",
    "RenderBlocking",
    "LCPBreakdown",
    "LCPDiscovery",
    "INPBreakdown"
  ];

  const selected = new Map<string, { insightSetId: string; insightName: string }>();

  for (const priority of priorities) {
    const match = discoveredInsights.find((insight) => insight.insightName === priority);
    if (match) {
      selected.set(`${match.insightSetId}:${match.insightName}`, match);
    }
    if (selected.size >= requestedCount) {
      return [...selected.values()];
    }
  }

  for (const insight of discoveredInsights) {
    selected.set(`${insight.insightSetId}:${insight.insightName}`, insight);
    if (selected.size >= requestedCount) {
      break;
    }
  }

  return [...selected.values()];
}

function describeEmulationMode(
  managedMode: boolean,
  deviceProfile: string,
  lightMode: boolean
): string {
  const prefix = managedMode
    ? "Chrome DevTools MCP managed Chromium emulation"
    : "Chrome DevTools MCP with Chromium emulation";

  if (lightMode) {
    return `${prefix} (light mode: desktop profile, no CPU throttling)`;
  }

  return `${prefix} (${deviceProfile})`;
}

function isSuccessfulArtifact(artifact: DevtoolsToolArtifact | null): boolean {
  return artifact !== null && !artifact.isError;
}

function skippedArtifact(toolName: string, reason: string): DevtoolsToolArtifact {
  return {
    toolName,
    arguments: {},
    isError: true,
    text: reason,
    structuredContent: null
  };
}

async function openAuditPage(
  client: ChromeDevtoolsMcpClient,
  url: string,
  timeoutMs: number,
  warnings: AuditWarning[],
  logger: AuditLogger
): Promise<{
  navigationArtifact: DevtoolsToolArtifact;
  pageId: number | null;
  hasSelectedPageContext: boolean;
}> {
  let newPageArtifact: DevtoolsToolArtifact | null = null;

  try {
    newPageArtifact = await requireSuccessfulTool(
      client.callTool(
        "new_page",
        {
          url,
          timeout: timeoutMs
        },
        timeoutMs + 30_000
      ),
      warnings
    );
  } catch (error) {
    await logger.log("navigation:new_page_threw", { error: String(error) });
  }

  if (newPageArtifact && !newPageArtifact.isError) {
    const context = await resolvePageSelection(client, newPageArtifact, warnings);
    return {
      navigationArtifact: newPageArtifact,
      pageId: context.pageId,
      hasSelectedPageContext: context.hasSelectedPageContext
    };
  }

  await logger.log("navigation:fallback_to_navigate_page", {
    reason: newPageArtifact?.text || "new_page failed or timed out"
  });

  const blankPageArtifact = await requireSuccessfulTool(
    client.callTool(
      "new_page",
      {
        url: "about:blank",
        timeout: Math.min(timeoutMs, 15_000)
      },
      Math.min(timeoutMs, 15_000) + 30_000
    ),
    warnings
  );

  const blankContext = await resolvePageSelection(client, blankPageArtifact, warnings);
  const navigateArtifact = await requireSuccessfulTool(
    client.callTool(
      "navigate_page",
      {
        ...(blankContext.pageId !== null ? { pageId: blankContext.pageId } : {}),
        url,
        timeout: timeoutMs
      },
      timeoutMs + 30_000
    ),
    warnings
  );

  return {
    navigationArtifact: navigateArtifact,
    pageId: blankContext.pageId,
    hasSelectedPageContext: blankContext.hasSelectedPageContext
  };
}

async function resolvePageSelection(
  client: ChromeDevtoolsMcpClient,
  sourceArtifact: DevtoolsToolArtifact,
  warnings: AuditWarning[]
): Promise<{
  pageId: number | null;
  hasSelectedPageContext: boolean;
}> {
  let pageId = extractPageId(sourceArtifact);
  let hasSelectedPageContext = false;

  if (pageId === null) {
    const listPagesArtifact = await optionalTool(client, "list_pages", {}, warnings);
    if (listPagesArtifact) {
      const pageIds = extractPageIds(listPagesArtifact);
      pageId = pageIds.at(-1) ?? null;
    }
  }

  if (pageId !== null) {
    await requireSuccessfulTool(
      client.callTool("select_page", { pageId, bringToFront: true }),
      warnings
    );
    hasSelectedPageContext = true;
  }

  return { pageId, hasSelectedPageContext };
}

async function buildScrollProfile(
  client: ChromeDevtoolsMcpClient,
  pageScopedArgs: Record<string, unknown>,
  scrollSteps: number,
  scrollPauseMs: number,
  warnings: AuditWarning[],
  logger: AuditLogger
): Promise<ScrollProfile | null> {
  const samples: ScrollProfileSample[] = [];

  for (let step = 0; step <= scrollSteps; step += 1) {
    const metrics = await optionalTool(
      client,
      "evaluate_script",
      {
        ...pageScopedArgs,
        function: `() => ({
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          domNodes: document.getElementsByTagName("*").length,
          usedJsHeapBytes: performance && 'memory' in performance && performance.memory
            ? performance.memory.usedJSHeapSize
            : null,
        })`
      },
      warnings
    );

    const parsed = parseScrollMetrics(metrics);
    if (parsed) {
      samples.push({
        step,
        ...parsed,
        timestamp: new Date().toISOString()
      });
      await logger.log("scroll:sample", samples.at(-1));
    }

    if (step < scrollSteps) {
      await optionalTool(
      client,
      "evaluate_script",
      {
          ...pageScopedArgs,
          function: `() => {
            window.scrollBy({ top: Math.max(window.innerHeight * 0.9, 600), behavior: 'instant' });
            return { scrollY: window.scrollY };
          }`
        },
        warnings
      );
      await sleep(scrollPauseMs);
    }
  }

  if (samples.length === 0) {
    return {
      attempted: true,
      executionMethod: "evaluate_script",
      completedSteps: 0,
      traceCapturedDuringScroll: true,
      samples,
      peakUsedJsHeapBytes: null,
      domNodeGrowth: null,
      maxDomNodes: null,
      cumulativeLayoutShift: null
    };
  }

  const heapValues = samples
    .map((sample) => sample.usedJsHeapBytes)
    .filter((value): value is number => typeof value === "number");
  const domValues = samples
    .map((sample) => sample.domNodes)
    .filter((value): value is number => typeof value === "number");

  return {
    attempted: true,
    executionMethod: "evaluate_script",
    completedSteps: samples.length,
    traceCapturedDuringScroll: true,
    samples,
    peakUsedJsHeapBytes: heapValues.length > 0 ? Math.max(...heapValues) : null,
    domNodeGrowth:
      domValues.length > 1 ? domValues[domValues.length - 1]! - domValues[0]! : null,
    maxDomNodes: domValues.length > 0 ? Math.max(...domValues) : null,
    cumulativeLayoutShift: null
  };
}

async function buildKeypressScrollProfile(
  client: ChromeDevtoolsMcpClient,
  scrollSteps: number,
  scrollPauseMs: number,
  warnings: AuditWarning[],
  logger: AuditLogger
): Promise<ScrollProfile | null> {
  const samples: ScrollProfileSample[] = [];
  let completedSteps = 0;

  const initialSnapshot = await sampleSnapshotScrollState(client, warnings, logger, 0);
  if (initialSnapshot) {
    samples.push(initialSnapshot);
  }

  for (let step = 0; step < scrollSteps; step += 1) {
    const result = await optionalTool(
      client,
      "press_key",
      {
        key: "PageDown"
      },
      warnings
    );

    if (!result || result.isError) {
      break;
    }

    completedSteps += 1;
    await logger.log("scroll:key_step", { step: completedSteps, key: "PageDown" });
    await sleep(scrollPauseMs);

    const snapshot = await sampleSnapshotScrollState(
      client,
      warnings,
      logger,
      completedSteps
    );
    if (snapshot) {
      samples.push(snapshot);
    }
  }

  const domValues = samples
    .map((sample) => sample.domNodes)
    .filter((value): value is number => typeof value === "number");

  return {
    attempted: true,
    executionMethod: samples.length > 0 ? "press_key_with_snapshot" : "press_key",
    completedSteps,
    traceCapturedDuringScroll: true,
    samples,
    peakUsedJsHeapBytes: null,
    domNodeGrowth:
      domValues.length > 1 ? domValues[domValues.length - 1]! - domValues[0]! : null,
    maxDomNodes: domValues.length > 0 ? Math.max(...domValues) : null,
    cumulativeLayoutShift: null
  };
}

function parseScrollMetrics(
  artifact: DevtoolsToolArtifact | null
): Omit<ScrollProfileSample, "step" | "timestamp"> | null {
  if (!artifact?.structuredContent || typeof artifact.structuredContent !== "object") {
    return null;
  }

  const record = artifact.structuredContent as Record<string, unknown>;
  const value = (key: string) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : null;

  return {
    scrollY: value("scrollY"),
    scrollHeight: value("scrollHeight"),
    viewportHeight: value("viewportHeight"),
    domNodes: value("domNodes"),
    usedJsHeapBytes: value("usedJsHeapBytes")
  };
}

async function sampleSnapshotScrollState(
  client: ChromeDevtoolsMcpClient,
  warnings: AuditWarning[],
  logger: AuditLogger,
  step: number
): Promise<ScrollProfileSample | null> {
  const snapshot = await optionalTool(client, "take_snapshot", {}, warnings);
  if (!snapshot || snapshot.isError) {
    return null;
  }

  const domNodes = countSnapshotNodes(snapshot.structuredContent);
  const sample: ScrollProfileSample = {
    step,
    scrollY: null,
    scrollHeight: null,
    viewportHeight: null,
    domNodes,
    usedJsHeapBytes: null,
    timestamp: new Date().toISOString()
  };
  await logger.log("scroll:snapshot_sample", sample);
  return sample;
}

function countSnapshotNodes(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const snapshot = value as Record<string, unknown>;
  const root = snapshot.snapshot;
  if (!root || typeof root !== "object") {
    return null;
  }

  let count = 0;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    count += 1;
    const record = node as Record<string, unknown>;
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };

  visit(root);
  return count;
}

async function enrichScrollProfileFromTrace(
  scrollProfile: ScrollProfile | null,
  tracePath: string,
  logger: AuditLogger
): Promise<ScrollProfile | null> {
  if (!scrollProfile) {
    return null;
  }

  try {
    const content = await fs.readFile(tracePath, "utf8");
    const trace = JSON.parse(content) as { traceEvents?: unknown[] };
    const events = Array.isArray(trace.traceEvents) ? trace.traceEvents : [];

    let peakJsHeapBytes: number | null = null;
    let firstTraceNodes: number | null = null;
    let maxTraceNodes: number | null = null;
    let cumulativeLayoutShift: number | null = null;

    for (const event of events) {
      if (!event || typeof event !== "object") {
        continue;
      }

      const record = event as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : null;
      if (!name) {
        continue;
      }

      if (name === "UpdateCounters") {
        const data = getNestedRecord(record, ["args", "data"]);
        const jsHeap = getNumber(data?.jsHeapSizeUsed);
        const nodes = getNumber(data?.nodes);

        if (jsHeap !== null) {
          peakJsHeapBytes = peakJsHeapBytes === null ? jsHeap : Math.max(peakJsHeapBytes, jsHeap);
        }
        if (nodes !== null) {
          firstTraceNodes ??= nodes;
          maxTraceNodes = maxTraceNodes === null ? nodes : Math.max(maxTraceNodes, nodes);
        }
      }

      if (name === "UkmPageLoadTimingUpdate") {
        const timing = getNestedRecord(record, ["args", "ukm_page_load_timing_update"]);
        const cls = getNumber(timing?.latest_cumulative_layout_shift);
        if (cls !== null) {
          cumulativeLayoutShift =
            cumulativeLayoutShift === null ? cls : Math.max(cumulativeLayoutShift, cls);
        }
      }
    }

    const enriched = {
      ...scrollProfile,
      peakUsedJsHeapBytes: scrollProfile.peakUsedJsHeapBytes ?? peakJsHeapBytes,
      domNodeGrowth:
        scrollProfile.domNodeGrowth ??
        (firstTraceNodes !== null && maxTraceNodes !== null ? maxTraceNodes - firstTraceNodes : null),
      maxDomNodes: scrollProfile.maxDomNodes ?? maxTraceNodes,
      cumulativeLayoutShift
    };

    await logger.log("scroll:trace_enrichment", {
      peakJsHeapBytes: enriched.peakUsedJsHeapBytes,
      domNodeGrowth: enriched.domNodeGrowth,
      maxDomNodes: enriched.maxDomNodes,
      cumulativeLayoutShift: enriched.cumulativeLayoutShift
    });

    return enriched;
  } catch (error) {
    await logger.log("scroll:trace_enrichment_failed", { error: String(error) });
    return scrollProfile;
  }
}

function getNestedRecord(
  value: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current && typeof current === "object" ? (current as Record<string, unknown>) : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractLiveDomElementCount(
  evaluation: DevtoolsToolArtifact | null,
  scrollProfile: ScrollProfile | null
): number | null {
  const structured = evaluation?.structuredContent;
  if (structured && typeof structured === "object") {
    const domNodes = (structured as Record<string, unknown>).domNodes;
    if (typeof domNodes === "number" && Number.isFinite(domNodes)) {
      return domNodes;
    }
  }

  return scrollProfile?.maxDomNodes ?? null;
}

function extractHeapGraphNodeCount(memory: MemoryArtifacts | null): number | null {
  const structured = memory?.summary?.structuredContent;
  if (structured && typeof structured === "object") {
    const staticData = (structured as Record<string, unknown>).staticData;
    if (staticData && typeof staticData === "object") {
      const nodeCount = (staticData as Record<string, unknown>).nodeCount;
      if (typeof nodeCount === "number" && Number.isFinite(nodeCount)) {
        return nodeCount;
      }
    }
  }

  const text = memory?.summary?.text ?? "";
  const match = text.match(/"nodeCount":\s*(\d+)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function buildRuntimeMcpArgs(request: Required<AuditRequest>): string[] {
  const args = [...request.mcpArgs];

  if (request.launchManagedBrowser) {
    removeArgsWithPrefix(args, "--browser-url=");
  }

  if (request.browserUrl) {
    removeArgsWithPrefix(args, "--browser-url=");
    removeExactArg(args, "--isolated=true");
    removeExactArg(args, "--isolated");
    removeExactArg(args, "--experimentalPageIdRouting=true");
    removeExactArg(args, "--experimentalPageIdRouting");
    args.push(`--browser-url=${request.browserUrl}`);
  }

  if (request.logFile) {
    removeArgsWithPrefix(args, "--log-file=");
    args.push(`--log-file=${request.logFile}`);
  }

  return args;
}

function removeArgsWithPrefix(args: string[], prefix: string): void {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index]?.startsWith(prefix)) {
      args.splice(index, 1);
    }
  }
}

function removeExactArg(args: string[], value: string): void {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === value) {
      args.splice(index, 1);
    }
  }
}
