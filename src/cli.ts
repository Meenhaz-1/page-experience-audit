import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import "./env.js";
import type { AiMode, AuditArtifact, AuditRequest, DevtoolsToolArtifact } from "./core/index.js";
import { ArtifactStore, OpenAiProvider, runAuditInputSchema } from "./core/index.js";
import { probeBrowserEndpoint } from "./core/devtools-mcp-client.js";
import { createAuditEngine } from "./engine.js";
import { auditArtifactPath, auditReportsDir, auditRunDir } from "./core/utils.js";

function reportProgress(message: string, extra?: unknown): void {
  const rendered = formatProgressMessage(message, extra);
  if (!rendered) {
    return;
  }

  process.stderr.write(`${rendered}\n`);
}

function parseArgs(argv: string[]) {
  const [url, ...rest] = argv;
  const options: Record<string, unknown> = { url };
  let phased = false;
  let compareUrl: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];

    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--settle-ms" && next) {
      options.settleTimeMs = Number(next);
      index += 1;
    } else if (arg === "--cpu-throttle" && next) {
      options.cpuThrottleRate = Number(next);
      index += 1;
    } else if (arg === "--device-profile" && next) {
      options.deviceProfile = next;
      index += 1;
    } else if (arg === "--light-mode") {
      options.lightMode = true;
    } else if (arg === "--phased") {
      phased = true;
    } else if (arg === "--ai-mode" && next) {
      options.aiMode = next;
      index += 1;
    } else if (arg === "--detail" && next) {
      options.outputDetail = next;
      index += 1;
    } else if (arg === "--no-lighthouse") {
      options.includeLighthouse = false;
    } else if (arg === "--no-memory") {
      options.includeMemory = false;
    } else if (arg === "--no-console") {
      options.includeConsole = false;
    } else if (arg === "--no-eval") {
      options.includeEvaluation = false;
    } else if (arg === "--no-scroll-profile") {
      options.includeScrollProfile = false;
    } else if (arg === "--analyze-insights" && next) {
      options.analyzeInsightsCount = Number(next);
      index += 1;
    } else if (arg === "--launch-managed-browser") {
      options.launchManagedBrowser = true;
    } else if (arg === "--scroll-steps" && next) {
      options.scrollSteps = Number(next);
      index += 1;
    } else if (arg === "--scroll-pause-ms" && next) {
      options.scrollPauseMs = Number(next);
      index += 1;
    } else if (arg === "--mcp-command" && next) {
      options.mcpCommand = next;
      index += 1;
    } else if (arg === "--mcp-arg" && next) {
      const existing = (options.mcpArgs as string[] | undefined) ?? [];
      existing.push(next);
      options.mcpArgs = existing;
      index += 1;
    } else if (arg === "--browser-url" && next) {
      options.browserUrl = next;
      index += 1;
    } else if (arg === "--compare-url" && next) {
      compareUrl = next;
      index += 1;
    } else if (arg === "--log-file" && next) {
      options.logFile = next;
      index += 1;
    }
  }

  return { options, phased, compareUrl };
}

async function main() {
  try {
    const { options, phased, compareUrl } = parseArgs(process.argv.slice(2));
    const parsed = runAuditInputSchema.parse(options);
    const engine = createAuditEngine(reportProgress);
    if (compareUrl) {
      const result = await runCompareAudit(engine, parsed, compareUrl, phased);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (phased) {
      const result = await runPhasedAudit(engine, parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const artifact = await engine.run(parsed);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Audit failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

void main();

type PhasedResult = Awaited<ReturnType<typeof runPhasedAudit>>;
type CompareMetric = {
  left: number | null;
  right: number | null;
  delta: number | null;
  preferred: "lower" | "higher";
};

type CompareSummary = {
  urls: {
    left: string;
    right: string;
  };
  audits: {
    left: string;
    right: string;
  };
  metrics: {
    liveDomElements: Omit<CompareMetric, "preferred">;
    heapGraphNodes: Omit<CompareMetric, "preferred">;
    warningCount: Omit<CompareMetric, "preferred">;
    peakScrollHeapBytes: Omit<CompareMetric, "preferred">;
    scrollDomGrowth: Omit<CompareMetric, "preferred">;
    scrollCls: Omit<CompareMetric, "preferred">;
  };
  headlines: {
    left: string | null;
    right: string | null;
  };
  nonTechnicalTldr: string;
  investigationFindings: string;
  observedBehavior: string;
  environment: string;
  toolsUsed: string;
  summaryNarrative: string;
  differenceDrivers: string[];
  measuredCounts: Array<{ label: string } & CompareMetric>;
  memoryDiff: {
    peakScrollHeapBytes: Omit<CompareMetric, "preferred">;
    heapSnapshotTotalBytes: Omit<CompareMetric, "preferred">;
    heapGraphNodes: Omit<CompareMetric, "preferred">;
    compiledCodeBytes: Omit<CompareMetric, "preferred">;
    stringsBytes: Omit<CompareMetric, "preferred">;
    jsArraysBytes: Omit<CompareMetric, "preferred">;
    topRetainedClasses: {
      left: string[];
      right: string[];
    };
    topRetainers: {
      left: string[];
      right: string[];
    };
  };
  mainThreadLockups: string[];
  extremeMemoryAllocation: string[];
  domSizeAndReflows: string[];
  thirdPartyPayload: string[];
  scriptActionPlan: string[];
  recommendedActions: string[];
  summary: string[];
};

async function runCompareAudit(
  engine: ReturnType<typeof createAuditEngine>,
  baseRequest: AuditRequest,
  compareUrl: string,
  phased: boolean
): Promise<{
  mode: "compare";
  phased: boolean;
  left: AuditArtifact;
  right: AuditArtifact;
  comparison: ReturnType<typeof buildComparisonSummary>;
  artifactPath: string;
  htmlReportPath: string;
}> {
  process.stderr.write(`[compare] running left URL\n`);
  const left = await runAuditWithMode(engine, baseRequest, phased);

  process.stderr.write(`[compare] running right URL\n`);
  const right = await runAuditWithMode(
    engine,
    runAuditInputSchema.parse({ ...baseRequest, url: compareUrl }),
    phased
  );

  const invalidLeft = !isAuditUsableForComparison(left);
  const invalidRight = !isAuditUsableForComparison(right);
  if (invalidLeft || invalidRight) {
    const failures = [
      invalidLeft ? `left URL (${left.request.url})` : null,
      invalidRight ? `right URL (${right.request.url})` : null
    ].filter((value): value is string => value !== null);
    throw new Error(
      `Comparison aborted because ${failures.join(" and ")} did not produce usable browser-backed coverage. Restart Chrome on the configured browser URL and rerun.`
    );
  }

  const comparison = buildComparisonSummary(left, right);
  const compareId = createCompareAuditId(left.request.url, right.request.url);
  const runDir = auditRunDir("audits", compareId);
  const artifactPath = auditArtifactPath("audits", compareId);
  const reportDir = auditReportsDir("audits", compareId);
  const htmlReportPath = path.join(reportDir, "summary.html");

  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    artifactPath,
    JSON.stringify(
      {
        compareId,
        createdAt: new Date().toISOString(),
        phased,
        left,
        right,
        comparison
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(htmlReportPath, renderComparisonHtml(compareId, left, right, comparison), "utf8");

  process.stderr.write(`[compare] persisted ${compareId}\n`);

  return {
    mode: "compare",
    phased,
    left,
    right,
    comparison,
    artifactPath,
    htmlReportPath
  };
}

async function runAuditWithMode(
  engine: ReturnType<typeof createAuditEngine>,
  request: AuditRequest,
  phased: boolean
): Promise<AuditArtifact> {
  await ensureBrowserPreflight(request, phased ? "phased audit" : "audit");
  if (phased) {
    const result = await runPhasedAudit(engine, request);
    return result.finalArtifact;
  }

  return engine.run(runAuditInputSchema.parse(request));
}

async function runPhasedAudit(
  engine: ReturnType<typeof createAuditEngine>,
  baseRequest: AuditRequest
): Promise<{
  mode: "phased";
  completedPhases: Array<{ phase: string; auditId: string; status: AuditArtifact["status"] }>;
  finalArtifact: AuditArtifact;
}> {
  const requestedAiMode = (baseRequest.aiMode ?? "disabled") as AiMode;
  const phases: Array<{ phase: string; request: AuditRequest }> = [
    {
      phase: "phase_1_lightweight",
      request: {
        ...baseRequest,
        aiMode: "disabled",
        includeMemory: false,
        includeLighthouse: false
      }
    },
    {
      phase: "phase_2_memory",
      request: {
        ...baseRequest,
        aiMode: "disabled",
        includeMemory: true,
        includeLighthouse: false
      }
    },
    {
      phase: "phase_3_lighthouse",
      request: {
        ...baseRequest,
        aiMode: "disabled",
        includeMemory: true,
        includeLighthouse: true
      }
    }
  ];

  const completedPhases: Array<{ phase: string; auditId: string; status: AuditArtifact["status"] }> = [];
  const phaseArtifacts: Array<{ phase: string; artifact: AuditArtifact }> = [];
  let finalArtifact: AuditArtifact | null = null;
  const phasePreflightWarnings: AuditArtifact["warnings"] = [];

  for (const current of phases) {
    const preflight = await checkBrowserPreflight(current.request, current.phase);
    if (preflight !== null) {
      process.stderr.write(`[phase] stopping before ${current.phase}: ${preflight.message}\n`);
      phasePreflightWarnings.push(preflight);
      if (phaseArtifacts.length === 0) {
        throw new Error(preflight.message);
      }
      break;
    }

    process.stderr.write(`\n[phase] starting ${current.phase}\n`);
    const artifact = await engine.run(runAuditInputSchema.parse(current.request));
    completedPhases.push({
      phase: current.phase,
      auditId: artifact.auditId,
      status: artifact.status
    });
    phaseArtifacts.push({
      phase: current.phase,
      artifact
    });
    finalArtifact = artifact;
    process.stderr.write(
      `[phase] completed ${current.phase} status=${artifact.status} warnings=${artifact.warnings.length}\n`
    );

    if (current.phase === "phase_1_lightweight" && !isPhaseOneHealthy(artifact)) {
      process.stderr.write("[phase] stopping after phase_1_lightweight because health checks did not pass\n");
      break;
    }

    if (current.phase === "phase_2_memory" && !isPhaseTwoHealthy(artifact)) {
      process.stderr.write("[phase] stopping after phase_2_memory because health checks did not pass\n");
      break;
    }
  }

  if (!finalArtifact) {
    throw new Error("Phased audit did not produce any artifact.");
  }

  const mergedArtifact = buildMergedPhasedArtifact(
    phaseArtifacts,
    baseRequest,
    phasePreflightWarnings
  );

  await applyAiAndPersist(mergedArtifact, requestedAiMode);
  process.stderr.write(
    `[phase] merged final artifact ${mergedArtifact.auditId} status=${mergedArtifact.status}\n`
  );

  return {
    mode: "phased",
    completedPhases,
    finalArtifact: mergedArtifact
  };
}

function isPhaseOneHealthy(artifact: AuditArtifact): boolean {
  return (
    !artifact.trace.startTrace.isError &&
    !artifact.trace.stopTrace.isError &&
    (!artifact.debugging.pageSnapshot?.isError ||
      !artifact.debugging.networkRequests?.isError ||
      !artifact.debugging.consoleMessages?.isError)
  );
}

function isPhaseTwoHealthy(artifact: AuditArtifact): boolean {
  if (!artifact.request.includeMemory) {
    return true;
  }

  return (
    artifact.memory !== null &&
    artifact.memory.takeHeapSnapshot !== null &&
    !artifact.memory.takeHeapSnapshot.isError &&
    artifact.memory.summary !== null &&
    !artifact.memory.summary.isError
  );
}

function buildMergedPhasedArtifact(
  phases: Array<{ phase: string; artifact: AuditArtifact }>,
  baseRequest: AuditRequest,
  extraWarnings: AuditArtifact["warnings"] = []
): AuditArtifact {
  const artifacts = phases.map((entry) => entry.artifact);
  const primary = artifacts[artifacts.length - 1]!;
  const earliest = artifacts[0]!;
  const traceSource = artifacts.find((artifact) => !artifact.trace.stopTrace.isError) ?? primary;
  const memorySource = [...artifacts].reverse().find((artifact) => artifact.memory !== null) ?? null;
  const snapshotSource =
    artifacts.find((artifact) => artifact.debugging.pageSnapshot && !artifact.debugging.pageSnapshot.isError) ?? primary;
  const networkSource =
    artifacts.find((artifact) => artifact.debugging.networkRequests && !artifact.debugging.networkRequests.isError) ?? primary;
  const consoleSource =
    artifacts.find((artifact) => artifact.debugging.consoleMessages && !artifact.debugging.consoleMessages.isError) ?? primary;
  const evaluationSource =
    artifacts.find((artifact) => artifact.debugging.evaluation && !artifact.debugging.evaluation.isError) ?? primary;
  const scrollSource = chooseBestScrollSource(artifacts) ?? primary;

  const mergedWarnings = artifacts.flatMap((artifact, index) =>
    artifact.warnings.map((warning) => ({
      ...warning,
      message: `[${phases[index]?.phase ?? `phase_${index + 1}`}] ${warning.message}`
    }))
  );

  return {
    ...primary,
    auditId: createPhasedAuditId(baseRequest.url),
    request: {
      ...primary.request,
      includeMemory: Boolean(baseRequest.includeMemory ?? true),
      includeLighthouse: Boolean(baseRequest.includeLighthouse ?? true),
      aiMode: (baseRequest.aiMode ?? "disabled") as AuditArtifact["request"]["aiMode"]
    },
    navigation: earliest.navigation,
    trace: traceSource.trace,
    memory: memorySource?.memory ?? null,
    debugging: {
      pageSnapshot: snapshotSource.debugging.pageSnapshot,
      networkRequests: networkSource.debugging.networkRequests,
      evaluation: evaluationSource.debugging.evaluation,
      rerenderProbe: evaluationSource.debugging.rerenderProbe,
      consoleMessages: consoleSource.debugging.consoleMessages,
      consoleMessageDetails: consoleSource.debugging.consoleMessageDetails,
      lighthouse: primary.debugging.lighthouse
    },
    scrollProfile: scrollSource.scrollProfile,
    derivedSignals: {
      ...primary.derivedSignals,
      insightCount: traceSource.derivedSignals.insightCount,
      consoleMessageCount: consoleSource.derivedSignals.consoleMessageCount,
      memoryAnalysisIncluded: memorySource?.derivedSignals.memoryAnalysisIncluded ?? false,
      lighthouseIncluded: primary.derivedSignals.lighthouseIncluded,
      scrollProfileIncluded: scrollSource.derivedSignals.scrollProfileIncluded,
      liveDomElementCount:
        evaluationSource.derivedSignals.liveDomElementCount ?? scrollSource.derivedSignals.liveDomElementCount,
      heapGraphNodeCount: memorySource?.derivedSignals.heapGraphNodeCount ?? null
    },
    warnings: [...mergedWarnings, ...extraWarnings],
    aiOutput: null,
    createdAt: new Date().toISOString()
  };
}

async function ensureBrowserPreflight(request: AuditRequest, label: string): Promise<void> {
  const warning = await checkBrowserPreflight(request, label);
  if (warning) {
    throw new Error(warning.message);
  }
}

async function checkBrowserPreflight(
  request: AuditRequest,
  label: string
): Promise<AuditArtifact["warnings"][number] | null> {
  if (!request.browserUrl || request.launchManagedBrowser) {
    return null;
  }

  process.stderr.write(`[preflight] checking browser endpoint for ${label}\n`);
  const probe = await probeBrowserEndpoint(request.browserUrl);
  if (probe.ok) {
    process.stderr.write(`[preflight] browser endpoint healthy ${probe.endpoint}\n`);
    return null;
  }

  return {
    code: "MCP_CONNECTION_FAILED",
    message: `Browser preflight failed for ${label}: ${probe.endpoint} was not reachable (${probe.error ?? "unknown error"}).`,
    recoverable: true
  };
}

function isAuditUsableForComparison(artifact: AuditArtifact): boolean {
  return (
    isUsableArtifact(artifact.debugging.pageSnapshot) ||
    isUsableArtifact(artifact.debugging.networkRequests) ||
    isUsableArtifact(artifact.debugging.consoleMessages) ||
    isUsableArtifact(artifact.trace.stopTrace) ||
    Boolean(artifact.scrollProfile && artifact.scrollProfile.samples.length > 0) ||
    Boolean(artifact.memory && isUsableArtifact(artifact.memory.summary))
  );
}

function isUsableArtifact(artifact: DevtoolsToolArtifact | null): boolean {
  return Boolean(artifact && !artifact.isError);
}

async function applyAiAndPersist(artifact: AuditArtifact, aiMode: AiMode): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const aiProvider = apiKey ? new OpenAiProvider(apiKey) : undefined;
  const store = new ArtifactStore();

  if (aiMode !== "disabled" && aiProvider) {
    artifact.aiOutput = await aiProvider.analyze(artifact, aiMode);
  }

  await store.persist(artifact);
}

function createPhasedAuditId(url: string): string {
  const hash = Buffer.from(url).toString("base64url").slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `phased_audit_${timestamp}_${hash}`;
}

function chooseBestScrollSource(artifacts: AuditArtifact[]): AuditArtifact | null {
  return artifacts
    .filter((artifact) => artifact.scrollProfile !== null)
    .sort((left, right) => scoreScrollProfile(right.scrollProfile) - scoreScrollProfile(left.scrollProfile))[0] ?? null;
}

function scoreScrollProfile(scrollProfile: AuditArtifact["scrollProfile"]): number {
  if (!scrollProfile) {
    return -1;
  }

  return (
    scrollProfile.samples.length * 10 +
    (scrollProfile.maxDomNodes !== null ? 5 : 0) +
    (scrollProfile.peakUsedJsHeapBytes !== null ? 5 : 0) +
    (scrollProfile.cumulativeLayoutShift !== null ? 3 : 0) +
    scrollProfile.completedSteps
  );
}

function buildComparisonSummary(left: AuditArtifact, right: AuditArtifact): CompareSummary {
  const leftScroll = left.scrollProfile;
  const rightScroll = right.scrollProfile;
  const metricSummary = {
    liveDomElements: metricPair(left.derivedSignals.liveDomElementCount, right.derivedSignals.liveDomElementCount),
    heapGraphNodes: metricPair(left.derivedSignals.heapGraphNodeCount, right.derivedSignals.heapGraphNodeCount),
    warningCount: metricPair(left.warnings.length, right.warnings.length),
    peakScrollHeapBytes: metricPair(leftScroll?.peakUsedJsHeapBytes ?? null, rightScroll?.peakUsedJsHeapBytes ?? null),
    scrollDomGrowth: metricPair(leftScroll?.domNodeGrowth ?? null, rightScroll?.domNodeGrowth ?? null),
    scrollCls: metricPair(leftScroll?.cumulativeLayoutShift ?? null, rightScroll?.cumulativeLayoutShift ?? null)
  };
  const driverInsights = buildDriverInsights(left, right, metricSummary);
  const leftHeapStats = extractHeapSnapshotStats(left);
  const rightHeapStats = extractHeapSnapshotStats(right);
  const leftTopClasses = extractTopRetainedClasses(left, 5);
  const rightTopClasses = extractTopRetainedClasses(right, 5);
  const leftTopRetainers = extractTopRetainers(left, 5);
  const rightTopRetainers = extractTopRetainers(right, 5);
  const leftSummary = left.aiOutput?.summary ?? null;
  const rightSummary = right.aiOutput?.summary ?? null;

  return {
    urls: {
      left: left.request.url,
      right: right.request.url
    },
    audits: {
      left: left.auditId,
      right: right.auditId
    },
    metrics: metricSummary,
    headlines: {
      left: left.aiOutput?.summary?.headline ?? null,
      right: right.aiOutput?.summary?.headline ?? null
    },
    nonTechnicalTldr: buildComparisonTldr(left, right, metricSummary, driverInsights),
    investigationFindings: buildComparisonInvestigationFindings(left, right, driverInsights),
    observedBehavior: buildComparisonObservedBehavior(left, right),
    environment: `${left.environment.emulation} compared against ${right.environment.emulation}`,
    toolsUsed: "chrome-devtools-mcp trace, scroll profile, page snapshot, network requests, console collection, memory snapshot, optional Lighthouse/AI synthesis",
    summaryNarrative: buildComparisonSummaryNarrative(left, right, driverInsights),
    differenceDrivers: driverInsights,
    measuredCounts: [
      { label: "Live DOM Elements", ...metricSummary.liveDomElements, preferred: "lower" as const },
      { label: "Heap Graph Nodes", ...metricSummary.heapGraphNodes, preferred: "lower" as const },
      { label: "Warning Count", ...metricSummary.warningCount, preferred: "lower" as const },
      { label: "Peak Scroll Heap Bytes", ...metricSummary.peakScrollHeapBytes, preferred: "lower" as const },
      { label: "Scroll DOM Growth", ...metricSummary.scrollDomGrowth, preferred: "lower" as const },
      { label: "Scroll CLS", ...metricSummary.scrollCls, preferred: "lower" as const }
    ],
    memoryDiff: {
      peakScrollHeapBytes: metricSummary.peakScrollHeapBytes,
      heapSnapshotTotalBytes: metricPair(leftHeapStats.totalBytes, rightHeapStats.totalBytes),
      heapGraphNodes: metricSummary.heapGraphNodes,
      compiledCodeBytes: metricPair(leftHeapStats.compiledCodeBytes, rightHeapStats.compiledCodeBytes),
      stringsBytes: metricPair(leftHeapStats.stringsBytes, rightHeapStats.stringsBytes),
      jsArraysBytes: metricPair(leftHeapStats.jsArraysBytes, rightHeapStats.jsArraysBytes),
      topRetainedClasses: {
        left: leftTopClasses,
        right: rightTopClasses
      },
      topRetainers: {
        left: leftTopRetainers,
        right: rightTopRetainers
      }
    },
    mainThreadLockups: compareFindingSection(
      "main-thread and forced-reflow work",
      leftSummary?.mainThreadLockups ?? [],
      rightSummary?.mainThreadLockups ?? [],
      left.request.url,
      right.request.url
    ),
    extremeMemoryAllocation: buildCompareMemoryFindings(left, right),
    domSizeAndReflows: compareFindingSection(
      "DOM size, scroll growth, and layout churn",
      leftSummary?.domSizeAndReflows ?? [],
      rightSummary?.domSizeAndReflows ?? [],
      left.request.url,
      right.request.url
    ),
    thirdPartyPayload: compareFindingSection(
      "third-party payload and ad-tech cost",
      leftSummary?.thirdPartyPayload ?? [],
      rightSummary?.thirdPartyPayload ?? [],
      left.request.url,
      right.request.url
    ),
    scriptActionPlan: buildCompareActionPlan(
      leftSummary?.scriptActionPlan ?? [],
      rightSummary?.scriptActionPlan ?? [],
      driverInsights
    ),
    recommendedActions: buildCompareActionPlan(
      leftSummary?.recommendedActions ?? [],
      rightSummary?.recommendedActions ?? [],
      driverInsights
    ),
    summary: [
      summarizeComparison("Peak scroll heap", leftScroll?.peakUsedJsHeapBytes ?? null, rightScroll?.peakUsedJsHeapBytes ?? null, "lower"),
      summarizeComparison("Scroll DOM growth", leftScroll?.domNodeGrowth ?? null, rightScroll?.domNodeGrowth ?? null, "lower"),
      summarizeComparison("Scroll CLS", leftScroll?.cumulativeLayoutShift ?? null, rightScroll?.cumulativeLayoutShift ?? null, "lower"),
      summarizeComparison("Heap graph nodes", left.derivedSignals.heapGraphNodeCount, right.derivedSignals.heapGraphNodeCount, "lower"),
      summarizeComparison("Warnings", left.warnings.length, right.warnings.length, "lower")
    ].filter((item): item is string => item !== null)
  };
}

function metricPair(left: number | null, right: number | null) {
  return {
    left,
    right,
    delta: left !== null && right !== null ? right - left : null
  };
}

function summarizeComparison(
  label: string,
  left: number | null,
  right: number | null,
  preferred: "lower" | "higher"
): string | null {
  if (left === null || right === null) {
    return null;
  }

  if (left === right) {
    return `${label}: both runs were effectively the same.`;
  }

  const rightBetter = preferred === "lower" ? right < left : right > left;
  const winner = rightBetter ? "right URL" : "left URL";
  return `${label}: ${winner} performed better (${formatMaybeNumber(left)} vs ${formatMaybeNumber(right)}).`;
}

function createCompareAuditId(leftUrl: string, rightUrl: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${leftUrl}::${rightUrl}`)
    .digest("hex")
    .slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `compare_${timestamp}_${hash}`;
}

function renderComparisonHtml(
  compareId: string,
  left: AuditArtifact,
  right: AuditArtifact,
  comparison: CompareSummary
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Audit Comparison ${escapeHtml(compareId)}</title>
  <style>
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f7f4ed; color: #1f1d1a; }
    main { max-width: 1120px; margin: 0 auto; padding: 48px 24px 80px; }
    h1 { font-size: 2.4rem; line-height: 1.1; margin: 0 0 24px; }
    h2 { font-size: 1.35rem; margin: 32px 0 12px; border-top: 1px solid #d8cfbf; padding-top: 20px; }
    h3 { font-size: 1.08rem; margin: 20px 0 10px; }
    p, li, td, th { line-height: 1.7; font-size: 1rem; }
    ul { padding-left: 22px; }
    section { margin-bottom: 18px; }
    .hero { background: linear-gradient(180deg, #fff9ef, #f6eee1); border: 1px solid #dfd2bd; border-radius: 18px; padding: 22px 22px 8px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card, .meta-card { background: #fffdf8; border: 1px solid #e4dccd; border-radius: 14px; padding: 18px; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .metric-card { background: #fffdf8; border: 1px solid #e4dccd; border-radius: 14px; padding: 18px; }
    .metric-label { color: #6a6358; font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric-value { font-size: 1.6rem; line-height: 1.1; margin-top: 8px; }
    .lede, .muted { color: #5b544b; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid #e4dccd; text-align: left; padding: 10px 8px; vertical-align: top; }
    th { text-transform: uppercase; font-size: 0.84rem; letter-spacing: 0.04em; color: #6a6358; }
    @media (max-width: 900px) { .metric-grid { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 760px) { .grid, .meta-grid, .metric-grid { grid-template-columns: 1fr; } main { padding: 28px 16px 56px; } h1 { font-size: 2rem; } }
  </style>
</head>
<body>
  <main>
    <h1>Audit Comparison</h1>
    <p class="lede">Side-by-side comparison for two URLs run with the same audit settings.</p>
    <section class="hero">
      <h2>Non-Technical TL;DR</h2>
      ${renderNarrative(comparison.nonTechnicalTldr)}
    </section>
    <section>
      <h2>Top-Level Hits</h2>
      <table>
        <thead>
          <tr>
            <th>Area</th>
            <th>Left</th>
            <th>Right</th>
            <th>Better</th>
            <th>Why It Matters</th>
          </tr>
        </thead>
        <tbody>
          ${renderTopLevelHitRow(
            "Peak Scroll Heap",
            comparison.metrics.peakScrollHeapBytes,
            "lower",
            "Shows which version builds more JavaScript memory pressure while the user moves through the experience."
          )}
          ${renderTopLevelHitRow(
            "Scroll DOM Growth",
            comparison.metrics.scrollDomGrowth,
            "lower",
            "Shows which version keeps adding more DOM during the scroll path instead of reusing or unloading content."
          )}
          ${renderTopLevelHitRow(
            "Scroll CLS",
            comparison.metrics.scrollCls,
            "lower",
            "Shows which version shifts layout more while content, ads, or lazy-loaded modules appear."
          )}
          ${renderTopLevelHitRow(
            "Heap Graph Nodes",
            comparison.metrics.heapGraphNodes,
            "lower",
            "Shows which version retains a larger overall heap graph after the run."
          )}
          ${renderTopLevelHitRow(
            "Warning Count",
            comparison.metrics.warningCount,
            "lower",
            "Shows which run was noisier or less stable from a tooling/runtime perspective."
          )}
        </tbody>
      </table>
    </section>
    <section class="meta-grid">
      <div class="meta-card">
        <h2>Investigation Findings</h2>
        ${renderNarrative(comparison.investigationFindings)}
      </div>
      <div class="meta-card">
        <h2>Run Context</h2>
        <p><strong>Observed Behavior:</strong> ${escapeHtml(comparison.observedBehavior)}</p>
        <p><strong>Environment:</strong> ${escapeHtml(comparison.environment)}</p>
        <p><strong>Tools Used:</strong> ${escapeHtml(comparison.toolsUsed)}</p>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <h2>Left URL</h2>
        <p>${escapeHtml(left.request.url)}</p>
        <p><strong>Audit ID:</strong> ${escapeHtml(left.auditId)}</p>
        <p><strong>Status:</strong> ${escapeHtml(left.status)}</p>
        <p><strong>Headline:</strong> ${escapeHtml(left.aiOutput?.summary?.headline ?? "n/a")}</p>
      </div>
      <div class="card">
        <h2>Right URL</h2>
        <p>${escapeHtml(right.request.url)}</p>
        <p><strong>Audit ID:</strong> ${escapeHtml(right.auditId)}</p>
        <p><strong>Status:</strong> ${escapeHtml(right.status)}</p>
        <p><strong>Headline:</strong> ${escapeHtml(right.aiOutput?.summary?.headline ?? "n/a")}</p>
      </div>
    </section>
    <section>
      <h2>Summary</h2>
      ${renderNarrative(comparison.summaryNarrative)}
      ${renderList(comparison.summary)}
    </section>
    <section>
      <h2>What Is Driving The Difference</h2>
      ${renderList(comparison.differenceDrivers)}
    </section>
    <section>
      <h2>Memory Diff</h2>
      <table>
        <thead>
          <tr>
            <th>Memory Metric</th>
            <th>Left</th>
            <th>Right</th>
            <th>Delta (Right - Left)</th>
            <th>Better</th>
          </tr>
        </thead>
        <tbody>
          ${renderCompareMetricRow("Peak JS Heap During Scroll", { ...comparison.memoryDiff.peakScrollHeapBytes, preferred: "lower" })}
          ${renderCompareMetricRow("Heap Snapshot Total Size", { ...comparison.memoryDiff.heapSnapshotTotalBytes, preferred: "lower" })}
          ${renderCompareMetricRow("Heap Graph Nodes", { ...comparison.memoryDiff.heapGraphNodes, preferred: "lower" })}
          ${renderCompareMetricRow("Compiled Code Size", { ...comparison.memoryDiff.compiledCodeBytes, preferred: "lower" })}
          ${renderCompareMetricRow("Strings Size", { ...comparison.memoryDiff.stringsBytes, preferred: "lower" })}
          ${renderCompareMetricRow("JS Arrays Size", { ...comparison.memoryDiff.jsArraysBytes, preferred: "lower" })}
        </tbody>
      </table>
      <div class="grid">
        <div class="card">
          <h3>Top Retained Classes: Left</h3>
          ${renderList(comparison.memoryDiff.topRetainedClasses.left)}
        </div>
        <div class="card">
          <h3>Top Retained Classes: Right</h3>
          ${renderList(comparison.memoryDiff.topRetainedClasses.right)}
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <h3>Top Retainers: Left</h3>
          ${renderList(comparison.memoryDiff.topRetainers.left)}
        </div>
        <div class="card">
          <h3>Top Retainers: Right</h3>
          ${renderList(comparison.memoryDiff.topRetainers.right)}
        </div>
      </div>
    </section>
    <section class="metric-grid">
      <h2>Measured Counts</h2>
          ${comparison.measuredCounts
        .map(
          (metric: { label: string } & CompareMetric) => `<div class="metric-card">
            <div class="metric-label">${escapeHtml(metric.label)}</div>
            <div class="metric-value">${escapeHtml(formatMetricWinner(metric.left, metric.right, metric.preferred))}</div>
            <p><strong>Left:</strong> ${escapeHtml(formatMaybeNumber(metric.left))}</p>
            <p><strong>Right:</strong> ${escapeHtml(formatMaybeNumber(metric.right))}</p>
            <p><strong>Delta:</strong> ${escapeHtml(formatMaybeNumber(metric.delta))}</p>
          </div>`
        )
        .join("")}
    </section>
    <section>
      <h2>Key Metrics</h2>
      <table>
        <thead>
          <tr><th>Metric</th><th>Left</th><th>Right</th><th>Delta (Right - Left)</th><th>Better</th></tr>
        </thead>
        <tbody>
          ${comparison.measuredCounts.map((metric) => renderCompareMetricRow(metric.label, metric)).join("")}
        </tbody>
      </table>
    </section>
    <section>
      <h2>Detailed Findings</h2>
      ${renderFindingSection("1. Main Thread Lockups", comparison.mainThreadLockups)}
      ${renderFindingSection("2. Extreme Memory Allocation", comparison.extremeMemoryAllocation)}
      ${renderFindingSection("3. DOM Size and Reflows", comparison.domSizeAndReflows)}
      ${renderFindingSection("4. Third-Party Payload", comparison.thirdPartyPayload)}
    </section>
    <section>
      <h2>Script Fix Action Plan</h2>
      ${renderList(comparison.scriptActionPlan)}
    </section>
    <section>
      <h2>Recommended Action Plan</h2>
      ${renderList(comparison.recommendedActions)}
    </section>
    <section>
      <h2>Artifact Context</h2>
      <p><strong>Compare ID:</strong> ${escapeHtml(compareId)}</p>
      <p><strong>Left Created:</strong> ${escapeHtml(left.createdAt)}</p>
      <p><strong>Right Created:</strong> ${escapeHtml(right.createdAt)}</p>
    </section>
  </main>
</body>
</html>`;
}

function renderCompareMetricRow(
  label: string,
  metric: CompareMetric
): string {
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td>${escapeHtml(formatMaybeNumber(metric.left))}</td>
    <td>${escapeHtml(formatMaybeNumber(metric.right))}</td>
    <td>${escapeHtml(formatMaybeNumber(metric.delta))}</td>
    <td>${escapeHtml(formatMetricWinner(metric.left, metric.right, metric.preferred))}</td>
  </tr>`;
}

function renderTopLevelHitRow(
  label: string,
  metric: { left: number | null; right: number | null; delta: number | null },
  preferred: "lower" | "higher",
  whyItMatters: string
): string {
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td>${escapeHtml(formatMaybeNumber(metric.left))}</td>
    <td>${escapeHtml(formatMaybeNumber(metric.right))}</td>
    <td>${escapeHtml(formatMetricWinner(metric.left, metric.right, preferred))}</td>
    <td>${escapeHtml(whyItMatters)}</td>
  </tr>`;
}

function buildComparisonTldr(
  left: AuditArtifact,
  right: AuditArtifact,
  metrics: CompareSummary["metrics"],
  drivers: string[]
): string {
  const winner = pickComparisonWinner(metrics);
  const opening =
    winner === "tie"
      ? "Both versions land in a similar overall performance range, with different tradeoffs rather than a clear winner."
      : winner === "left"
        ? "The left URL appears healthier overall in this run, mainly because it carries less runtime cost during scroll and/or fewer warning signals."
        : "The right URL appears healthier overall in this run, mainly because it carries less runtime cost during scroll and/or fewer warning signals.";
  const followUp =
    drivers[0] ??
    "The strongest differences came from scroll-time heap usage, DOM growth, layout shift, and warning volume rather than from one single headline metric.";
  return `${opening} ${followUp}`;
}

function buildComparisonInvestigationFindings(
  left: AuditArtifact,
  right: AuditArtifact,
  drivers: string[]
): string {
  const leftHeadline = left.aiOutput?.summary?.headline ?? "No AI headline was available for the left URL.";
  const rightHeadline = right.aiOutput?.summary?.headline ?? "No AI headline was available for the right URL.";
  return `Both URLs were audited with the same workflow so we can focus on relative differences instead of isolated findings. Left headline: ${leftHeadline} Right headline: ${rightHeadline} ${drivers.slice(0, 2).join(" ")}`;
}

function buildComparisonObservedBehavior(left: AuditArtifact, right: AuditArtifact): string {
  return `Left run ended with status ${left.status} and right run ended with status ${right.status}. This comparison emphasizes which version accumulated more memory, DOM growth, layout shift, warning noise, and script-related cost under the same audit flow.`;
}

function buildComparisonSummaryNarrative(
  left: AuditArtifact,
  right: AuditArtifact,
  drivers: string[]
): string {
  const leftWarnings = left.warnings.length;
  const rightWarnings = right.warnings.length;
  const warningSentence =
    leftWarnings === rightWarnings
      ? `Both runs produced the same warning count (${leftWarnings}), so the main differences come from runtime behavior rather than audit completeness.`
      : `Warning volume also differed (${leftWarnings} on the left vs ${rightWarnings} on the right), which helps explain why one run looks more stable or complete than the other.`;
  return `${warningSentence} ${drivers.slice(0, 3).join(" ")}`;
}

function buildDriverInsights(
  left: AuditArtifact,
  right: AuditArtifact,
  metrics: {
    peakScrollHeapBytes: { left: number | null; right: number | null; delta: number | null };
    scrollDomGrowth: { left: number | null; right: number | null; delta: number | null };
    scrollCls: { left: number | null; right: number | null; delta: number | null };
    heapGraphNodes: { left: number | null; right: number | null; delta: number | null };
    liveDomElements: { left: number | null; right: number | null; delta: number | null };
    warningCount: { left: number | null; right: number | null; delta: number | null };
  }
): string[] {
  const insights: string[] = [];
  pushMetricDriver(insights, "Scroll-time JS heap", metrics.peakScrollHeapBytes, "lower");
  pushMetricDriver(insights, "Scroll DOM growth", metrics.scrollDomGrowth, "lower");
  pushMetricDriver(insights, "Scroll CLS", metrics.scrollCls, "lower");
  pushMetricDriver(insights, "Heap graph size", metrics.heapGraphNodes, "lower");
  pushMetricDriver(insights, "Live DOM count", metrics.liveDomElements, "lower");
  pushMetricDriver(insights, "Warning count", metrics.warningCount, "lower");

  const leftThirdParty = left.aiOutput?.summary?.thirdPartyPayload?.[0];
  const rightThirdParty = right.aiOutput?.summary?.thirdPartyPayload?.[0];
  if (leftThirdParty || rightThirdParty) {
    insights.push(
      `Third-party/ad-tech behavior differs as well. Left strongest clue: ${leftThirdParty ?? "n/a"} Right strongest clue: ${rightThirdParty ?? "n/a"}`
    );
  }

  return insights;
}

function pushMetricDriver(
  insights: string[],
  label: string,
  metric: { left: number | null; right: number | null; delta: number | null },
  preferred: "lower" | "higher"
): void {
  const summary = summarizeComparison(label, metric.left, metric.right, preferred);
  if (summary) {
    insights.push(summary);
  }
}

function formatMetricWinner(
  left: number | null,
  right: number | null,
  preferred: "lower" | "higher"
): string {
  if (left === null || right === null) {
    return "n/a";
  }
  if (left === right) {
    return "tie";
  }
  const rightBetter = preferred === "lower" ? right < left : right > left;
  return rightBetter ? "right" : "left";
}

function compareFindingSection(
  label: string,
  leftItems: string[],
  rightItems: string[],
  leftUrl: string,
  rightUrl: string
): string[] {
  const findings: string[] = [];
  if (leftItems.length > 0) {
    findings.push(`Left (${leftUrl})` + `: ${leftItems[0]}`);
  }
  if (rightItems.length > 0) {
    findings.push(`Right (${rightUrl})` + `: ${rightItems[0]}`);
  }
  if (findings.length === 0) {
    findings.push(`No strong ${label} findings were available in the compared summaries.`);
  }
  return findings;
}

function buildCompareMemoryFindings(left: AuditArtifact, right: AuditArtifact): string[] {
  const findings: string[] = [];
  const leftHeapStats = extractHeapSnapshotStats(left);
  const rightHeapStats = extractHeapSnapshotStats(right);
  const leftSnapshotTotal = leftHeapStats.totalBytes;
  const rightSnapshotTotal = rightHeapStats.totalBytes;
  const leftPeakScrollHeap = left.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const rightPeakScrollHeap = right.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const leftHeapNodes = left.derivedSignals.heapGraphNodeCount;
  const rightHeapNodes = right.derivedSignals.heapGraphNodeCount;

  if (leftPeakScrollHeap !== null || rightPeakScrollHeap !== null) {
    findings.push(
      `Runtime scroll memory should be compared like-for-like: left peak used JS heap during scroll was ${formatBytesForNarrative(leftPeakScrollHeap)} and right peak used JS heap during scroll was ${formatBytesForNarrative(rightPeakScrollHeap)}.`
    );
  }

  if (leftSnapshotTotal !== null || rightSnapshotTotal !== null) {
    findings.push(
      `Retained heap snapshot size should also be compared like-for-like: left heap snapshot total size was ${formatBytesForNarrative(leftSnapshotTotal)} and right heap snapshot total size was ${formatBytesForNarrative(rightSnapshotTotal)}.`
    );
  }

  if (leftHeapNodes !== null || rightHeapNodes !== null) {
    findings.push(
      `Heap graph complexity should be compared separately from heap size: left heap graph nodes were ${formatMaybeNumber(leftHeapNodes)} and right heap graph nodes were ${formatMaybeNumber(rightHeapNodes)}.`
    );
  }

  if (leftHeapStats.compiledCodeBytes !== null || rightHeapStats.compiledCodeBytes !== null) {
    findings.push(
      `Compiled code size is a likely driver of retained-memory differences: left compiled code was ${formatBytesForNarrative(leftHeapStats.compiledCodeBytes)} and right compiled code was ${formatBytesForNarrative(rightHeapStats.compiledCodeBytes)}.`
    );
  }

  if (leftHeapStats.stringsBytes !== null || rightHeapStats.stringsBytes !== null) {
    findings.push(
      `String retention also differed: left strings were ${formatBytesForNarrative(leftHeapStats.stringsBytes)} and right strings were ${formatBytesForNarrative(rightHeapStats.stringsBytes)}.`
    );
  }

  if (leftPeakScrollHeap !== null && rightPeakScrollHeap !== null && leftSnapshotTotal !== null && rightSnapshotTotal !== null) {
    const mismatch =
      (leftPeakScrollHeap < rightPeakScrollHeap && leftSnapshotTotal > rightSnapshotTotal) ||
      (leftPeakScrollHeap > rightPeakScrollHeap && leftSnapshotTotal < rightSnapshotTotal);
    if (mismatch) {
      findings.push(
        "The memory story is split across two layers: one version can look better on live scroll-time heap usage while still retaining a larger total heap snapshot after the run. That usually points to lower visible runtime pressure but higher retained background/runtime state."
      );
    }
  }

  if (findings.length === 0) {
    findings.push("Memory comparison data was incomplete for one or both runs.");
  }

  return findings;
}

function extractHeapSnapshotStats(artifact: AuditArtifact): {
  totalBytes: number | null;
  compiledCodeBytes: number | null;
  stringsBytes: number | null;
  jsArraysBytes: number | null;
} {
  const structured = artifact.memory?.summary?.structuredContent;
  if (structured && typeof structured === "object") {
    const heapSnapshot = (structured as Record<string, unknown>).heapSnapshot;
    if (heapSnapshot && typeof heapSnapshot === "object") {
      const stats = (heapSnapshot as Record<string, unknown>).stats;
      if (stats && typeof stats === "object") {
        const v8heap = (stats as Record<string, unknown>).v8heap;
        return {
          totalBytes: getFiniteNumber((stats as Record<string, unknown>).total),
          compiledCodeBytes:
            v8heap && typeof v8heap === "object" ? getFiniteNumber((v8heap as Record<string, unknown>).code) : null,
          stringsBytes:
            v8heap && typeof v8heap === "object" ? getFiniteNumber((v8heap as Record<string, unknown>).strings) : null,
          jsArraysBytes:
            v8heap && typeof v8heap === "object" ? getFiniteNumber((v8heap as Record<string, unknown>).jsArrays) : null
        };
      }
    }
  }

  const text = artifact.memory?.summary?.text ?? "";
  return {
    totalBytes: extractNumberFromText(text, /"total":\s*(\d+)/),
    compiledCodeBytes: extractNumberFromText(text, /"code":\s*(\d+)/),
    stringsBytes: extractNumberFromText(text, /"strings":\s*(\d+)/),
    jsArraysBytes: extractNumberFromText(text, /"jsArrays":\s*(\d+)/)
  };
}

function formatBytesForNarrative(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  const mb = value / (1024 * 1024);
  return `${formatMaybeNumber(value)} bytes (~${mb.toFixed(1)} MB)`;
}

function extractTopRetainedClasses(artifact: AuditArtifact, limit: number): string[] {
  const data = artifact.memory?.details?.structuredContent;
  if (!data || typeof data !== "object") {
    return ["Not collected in this run."];
  }

  const rows = (data as Record<string, unknown>).heapSnapshotData;
  if (!Array.isArray(rows) || rows.length === 0) {
    return ["Not collected in this run."];
  }

  return rows.slice(0, limit).map((row) => {
    const record = row as Record<string, unknown>;
    return `${String(record.className ?? "unknown")}: count ${String(record.count ?? "n/a")}, self size ${String(record.selfSize ?? "n/a")}, retained size ${String(record.retainedSize ?? "n/a")}`;
  });
}

function extractTopRetainers(artifact: AuditArtifact, limit: number): string[] {
  const retainers = artifact.memory?.retainers ?? [];
  if (retainers.length === 0) {
    return ["Retainer paths were not collected in this run."];
  }

  return retainers.slice(0, limit).map((retainer) => retainer.text || `${retainer.toolName} returned structured retainer data.`);
}

function extractNumberFromText(text: string, regex: RegExp): number | null {
  const match = text.match(regex);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildCompareActionPlan(
  leftActions: string[],
  rightActions: string[],
  drivers: string[]
): string[] {
  const merged = new Set<string>();
  for (const action of [...leftActions, ...rightActions]) {
    if (action.trim()) {
      merged.add(action);
    }
  }
  for (const driver of drivers.slice(0, 2)) {
    merged.add(`Use the comparison deltas to prioritize the stronger regression driver first: ${driver}`);
  }
  return [...merged].slice(0, 8);
}

function pickComparisonWinner(metrics: {
  peakScrollHeapBytes: { left: number | null; right: number | null };
  scrollDomGrowth: { left: number | null; right: number | null };
  scrollCls: { left: number | null; right: number | null };
  warningCount: { left: number | null; right: number | null };
}): "left" | "right" | "tie" {
  let leftScore = 0;
  let rightScore = 0;
  for (const metric of [metrics.peakScrollHeapBytes, metrics.scrollDomGrowth, metrics.scrollCls, metrics.warningCount]) {
    if (metric.left === null || metric.right === null || metric.left === metric.right) {
      continue;
    }
    if (metric.left < metric.right) {
      leftScore += 1;
    } else {
      rightScore += 1;
    }
  }
  if (leftScore === rightScore) {
    return "tie";
  }
  return leftScore > rightScore ? "left" : "right";
}

function renderFindingSection(title: string, items: string[]): string {
  return `<section><h3>${escapeHtml(title)}</h3>${renderList(items)}</section>`;
}

function renderList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${paragraphize(item)}</li>`).join("")}</ul>`;
}

function renderNarrative(value: string): string {
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length <= 2) {
    return `<p>${paragraphize(value)}</p>`;
  }

  const chunks: string[] = [];
  for (let index = 0; index < sentences.length; index += 2) {
    chunks.push(sentences.slice(index, index + 2).join(" "));
  }

  return chunks.map((chunk) => `<p>${paragraphize(chunk)}</p>`).join("");
}

function paragraphize(value: string): string {
  return escapeHtml(value).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatProgressMessage(message: string, extra?: unknown): string | null {
  if (message === "audit:start") {
    const info = extra as { auditId?: string; url?: string; aiMode?: string } | undefined;
    return `[audit] start ${info?.auditId ?? ""} ${info?.url ?? ""} ai=${info?.aiMode ?? "disabled"}`.trim();
  }

  if (message === "mcp:connected") {
    return "[mcp] connected";
  }

  if (message === "mcp:tools") {
    const info = extra as { availableTools?: string[] } | undefined;
    return `[mcp] tools=${info?.availableTools?.length ?? 0}`;
  }

  if (message === "tool:start") {
    const info = extra as { toolName?: string; timeoutMs?: number } | undefined;
    return `[tool] start ${info?.toolName ?? "unknown"} timeout=${info?.timeoutMs ?? "n/a"}ms`;
  }

  if (message === "tool:end") {
    const info = extra as {
      toolName?: string;
      durationMs?: number;
      isError?: boolean;
      hasStructuredContent?: boolean;
    } | undefined;
    return `[tool] end ${info?.toolName ?? "unknown"} duration=${info?.durationMs ?? "n/a"}ms error=${info?.isError ? "yes" : "no"} structured=${info?.hasStructuredContent ? "yes" : "no"}`;
  }

  if (message.startsWith("navigation:")) {
    return `[nav] ${message.replace("navigation:", "")}`;
  }

  if (message.startsWith("scroll:")) {
    const info = extra as { step?: number; domNodes?: number | null; peakJsHeapBytes?: number | null } | undefined;
    if (message === "scroll:key_step") {
      return `[scroll] key step=${info?.step ?? "n/a"}`;
    }
    if (message === "scroll:snapshot_sample") {
      return `[scroll] sample step=${info?.step ?? "n/a"} dom=${info?.domNodes ?? "n/a"}`;
    }
    if (message === "scroll:trace_enrichment") {
      return `[scroll] trace enrichment peakHeap=${formatMaybeNumber(info?.peakJsHeapBytes)} domGrowth=${formatMaybeNumber((extra as { domNodeGrowth?: number | null } | undefined)?.domNodeGrowth)}`;
    }
    return `[scroll] ${message.replace("scroll:", "")}`;
  }

  if (message === "ai:start") {
    return "[ai] synthesis started";
  }

  if (message === "ai:end") {
    const info = extra as { provider?: string; model?: string } | undefined;
    return `[ai] synthesis finished provider=${info?.provider ?? "unknown"} model=${info?.model ?? "unknown"}`;
  }

  if (message === "audit:persisted") {
    const info = extra as { auditId?: string; status?: string } | undefined;
    return `[audit] persisted ${info?.auditId ?? ""} status=${info?.status ?? "unknown"}`.trim();
  }

  if (message === "audit:end") {
    const info = extra as { auditId?: string; status?: string; warningCount?: number } | undefined;
    return `[audit] end ${info?.auditId ?? ""} status=${info?.status ?? "unknown"} warnings=${info?.warningCount ?? 0}`.trim();
  }

  if (
    message === "mcp:connect_failed" ||
    message === "ai:failed" ||
    message === "audit:persist_failed"
  ) {
    return `[warn] ${message}`;
  }

  return null;
}

function formatMaybeNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "n/a";
}
