import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_AUDITS_DIR, withAuditDefaults } from "../core/defaults.js";
import type { AuditArtifact, AuditRequest } from "../core/types.js";
import { auditArtifactPath, auditReportsDir, auditRunDir, sanitizeFilenamePart } from "../core/utils.js";
import { createAuditEngine } from "../engine.js";
import type {
  QuickCheckArtifact,
  QuickCheckDecisionIssue,
  QuickCheckLensMetric,
  QuickCheckLensStatus,
  QuickCheckThirdPartyCpuVendor,
  QuickCheckUserJourneyLens,
  QuickCheckMetricRow,
  QuickCheckOverallStatus,
  QuickCheckPhaseResult,
  QuickCheckRequest
} from "./types.js";

export async function runQuickCheck(
  request: QuickCheckRequest,
  progressSink?: (message: string, extra?: unknown) => void
): Promise<QuickCheckArtifact> {
  const engine = createAuditEngine(progressSink);
  const audit = await engine.run(request);

  const artifact = buildQuickCheckArtifact(audit, request);
  const persisted = await persistQuickCheckArtifact(artifact);
  artifact.htmlReportPath = persisted.htmlReportPath;
  return artifact;
}

export function buildQuickCheckArtifact(
  audit: AuditArtifact,
  originalRequest: QuickCheckRequest
): QuickCheckArtifact {
  const normalized = withAuditDefaults({
    ...originalRequest,
    url: audit.request.url
  } as AuditRequest);
  const consoleErrorCount = countConsoleErrors(audit);
  const failedRequestCount = countFailedRequests(audit);
  const domNodeCount = extractDomNodeCount(audit);
  const iframeCount = extractEvaluationNumber(audit, "iframeCount");
  const imageCount = extractEvaluationNumber(audit, "imageCount");
  const eagerImagesBelowFold = extractEvaluationNumber(audit, "eagerImagesBelowFold");
  const eagerIframesBelowFold = extractEvaluationNumber(audit, "eagerIframesBelowFold");
  const missingLazyImages = extractEvaluationNumber(audit, "missingLazyImages");
  const missingLazyIframes = extractEvaluationNumber(audit, "missingLazyIframes");
  const longTaskCount = estimateLongTaskCount(audit);
  const rerenderSignal = extractRerenderSignal(audit);
  const adSignals = collectAdSignals(audit);
  const adImpactScore = computeAdImpactScore(audit);
  const adImpactLevel = classifyAdImpactLevel(audit);
  const thirdPartyCpuImpact = extractThirdPartyCpuImpact(audit);
  const lensInputs = {
    consoleErrorCount,
    failedRequestCount,
    domNodeCount,
    iframeCount,
    imageCount,
    eagerImagesBelowFold,
    eagerIframesBelowFold,
    missingLazyImages,
    missingLazyIframes,
    longTaskCount,
    rerenderSignal,
    adSignals,
    adImpactScore,
    adImpactLevel,
    thirdPartyCpuImpact
  };
  const overallStatus = classifyOverallStatus({
    audit,
    consoleErrorCount,
    failedRequestCount,
    domNodeCount,
    rerenderSignal
  });
  const userJourneyImpact = buildUserJourneyImpact(audit, lensInputs);
  const decisionIssues = buildDecisionIssues(audit, lensInputs, userJourneyImpact);
  const decisionSummary = buildDecisionSummary(decisionIssues, userJourneyImpact);
  const criticalAlerts = buildCriticalAlerts(audit, lensInputs, decisionIssues);
  const commonViewpointSummary =
    buildCommonViewpointSummary(userJourneyImpact) ??
    buildPlainEnglishSummary(overallStatus, audit, {
      consoleErrorCount,
      failedRequestCount,
      domNodeCount,
      rerenderSignal
    });
  const confidenceLevel = deriveConfidenceLevel(audit);
  const phaseResults = buildPhaseResults(audit, {
    consoleErrorCount,
    failedRequestCount,
    domNodeCount,
    rerenderSignal
  });
  const metricRows = buildMetricRows(audit, {
    consoleErrorCount,
    failedRequestCount,
    longTaskCount,
    domNodeCount,
    iframeCount,
    imageCount,
    eagerImagesBelowFold,
    eagerIframesBelowFold,
    missingLazyImages,
    missingLazyIframes,
    rerenderSignal
  });
  const topRisk = deriveTopRisk(audit, {
    consoleErrorCount,
    failedRequestCount,
    domNodeCount,
    rerenderSignal
  });
  const userImpact = deriveUserImpact(overallStatus, audit, {
    consoleErrorCount,
    failedRequestCount,
    rerenderSignal
  });
  const recommendedAction = deriveRecommendedAction(audit);
  const aiSummary = audit.aiOutput?.summary;
  const aiRecommendations = aiSummary?.recommendedActions ?? [];

  return {
    quickCheckId: createQuickCheckId(audit.request.url),
    createdAt: new Date().toISOString(),
    status: audit.status,
    overallStatus,
    confidenceLevel,
    request: {
      url: audit.request.url,
      flowDescription:
        originalRequest.flowDescription ??
        "Open the page, allow it to settle, inspect console and network activity, and capture a short trace-backed interaction/scroll profile.",
      limitations: buildLimitations(audit),
      deviceProfile: normalized.deviceProfile,
      browserUrl: normalized.browserUrl || null,
      launchManagedBrowser: normalized.launchManagedBrowser
    },
    environment: audit.environment,
    sourceAuditId: audit.auditId,
    sourceAuditPath: auditArtifactPath(DEFAULT_AUDITS_DIR, audit.auditId),
    plainEnglishSummary:
      aiSummary?.nonTechnicalTldr ??
      buildPlainEnglishSummary(overallStatus, audit, {
        consoleErrorCount,
        failedRequestCount,
        domNodeCount,
        rerenderSignal
      }),
    commonViewpointSummary,
    decisionSummary,
    criticalAlerts,
    topRisk: aiSummary?.primaryBottlenecks[0] ?? topRisk,
    userImpact: aiSummary?.observedBehavior ?? userImpact,
    recommendedAction: aiRecommendations[0] ?? recommendedAction,
    decisionIssues,
    userJourneyImpact,
    thirdPartyCpuImpact,
    phaseResults,
    metricRows,
    keyMetrics: {
      consoleErrorCount,
      failedRequestCount,
      longTaskCount,
      domNodeCount,
      domNodeGrowth: audit.scrollProfile?.domNodeGrowth ?? null,
      maxDomNodesObserved: audit.scrollProfile?.maxDomNodes ?? domNodeCount,
      iframeCount,
      imageCount,
      eagerImagesBelowFold,
      eagerIframesBelowFold,
      missingLazyImages,
      missingLazyIframes,
      adWarningCount: adSignals.adWarningCount,
      adRequestIssueCount: adSignals.adRequestIssueCount,
      adImpactScore,
      adImpactLevel,
      thirdPartyInsightPresent: hasInsight(audit, "ThirdParties"),
      forcedReflowInsightPresent: hasInsight(audit, "ForcedReflow"),
      peakScrollHeapBytes: audit.scrollProfile?.peakUsedJsHeapBytes ?? null,
      rerenderMutationCount: rerenderSignal.mutationCount,
      rerenderChangedNodeCount: rerenderSignal.changedNodeCount,
      rerenderLongFrameCount: rerenderSignal.longFrameCount
    },
    runtimeAnalysis: {
      domSummary: buildDomSummary(audit, domNodeCount),
      memorySummary: buildMemorySummary(audit),
      scrollGrowthSummary: buildScrollGrowthSummary(audit),
      lazyLoadingSummary: buildLazyLoadingSummary(audit),
      adImpactSummary: buildAdImpactSummary(audit)
    },
    evidence: {
      screenshotsHtml:
        "<p class=\"small\">No bitmap screenshots were captured by the shared audit engine for this run. Use the page snapshot and run logs as fallback evidence.</p>",
      consoleSummary: buildConsoleSummary(audit),
      networkSummary: buildNetworkSummary(audit),
      traceSummary: buildTraceSummary(audit)
    },
    recommendations: mergeRecommendations(
      aiRecommendations,
      buildRecommendations(audit, overallStatus, {
        consoleErrorCount,
        failedRequestCount,
        domNodeCount,
        rerenderSignal
      })
    ),
    appendixNotes:
      `${audit.aiOutput ? `AI synthesis: ${audit.aiOutput.mode} via ${audit.aiOutput.provider} (${audit.aiOutput.model}). ` : ""}This quick check is a repeatable browser-level diagnostic, not a replacement for real-user monitoring, WebPageTest, or device-specific mobile validation.`,
    mcpPrompt: buildMcpPrompt(audit.request.url, originalRequest.flowDescription),
    rawAudit: audit,
    htmlReportPath: null
  };
}

async function persistQuickCheckArtifact(
  artifact: QuickCheckArtifact
): Promise<{ htmlReportPath: string }> {
  const runDir = auditRunDir(DEFAULT_AUDITS_DIR, artifact.quickCheckId);
  const artifactPath = auditArtifactPath(DEFAULT_AUDITS_DIR, artifact.quickCheckId);
  const reportDir = auditReportsDir(DEFAULT_AUDITS_DIR, artifact.quickCheckId);
  const htmlReportPath = path.join(reportDir, "summary.html");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  await fs.writeFile(htmlReportPath, renderQuickCheckHtml(artifact), "utf8");
  return { htmlReportPath };
}

function buildPhaseResults(
  audit: AuditArtifact,
  counts: {
    consoleErrorCount: number;
    failedRequestCount: number;
    domNodeCount: number | null;
    rerenderSignal: RerenderSignal;
  }
): QuickCheckPhaseResult[] {
  const traceHealthy = !audit.trace.startTrace.isError && !audit.trace.stopTrace.isError;
  const consoleHealthy = audit.debugging.consoleMessages !== null && !audit.debugging.consoleMessages.isError;
  const networkHealthy = audit.debugging.networkRequests !== null && !audit.debugging.networkRequests.isError;
  const evaluationHealthy = audit.debugging.evaluation !== null && !audit.debugging.evaluation.isError;
  const rerenderHealthy = audit.debugging.rerenderProbe !== null && !audit.debugging.rerenderProbe.isError;
  const memoryHealthy = audit.memory?.summary !== null && !(audit.memory?.summary?.isError ?? true);

  return [
    {
      phase: "0",
      name: "Setup and page availability",
      status:
        audit.navigation.status === "terminal_error" || audit.navigation.status === "timeout"
          ? "Failed"
          : audit.navigation.status === "success"
            ? "Passed"
            : "Partial",
      finding: `Navigation ended as ${audit.navigation.status.replaceAll("_", " ")}.`,
      continued: audit.navigation.status !== "terminal_error"
    },
    {
      phase: "1",
      name: "Non-technical smoke check",
      status: evaluationHealthy ? "Passed" : "Partial",
      finding: evaluationHealthy
        ? "The page exposed enough client-side state for quick usability checks."
        : "Basic page-scoped evaluation was incomplete, so this run has lower confidence.",
      continued: true
    },
    {
      phase: "2",
      name: "Console health",
      status: consoleHealthy ? "Passed" : "Partial",
      finding: `${counts.consoleErrorCount} likely error-level console messages were captured.`,
      continued: true
    },
    {
      phase: "3",
      name: "Network health",
      status: networkHealthy ? "Passed" : "Partial",
      finding: `${counts.failedRequestCount} failed or explicitly errored requests were detected.`,
      continued: true
    },
    {
      phase: "4",
      name: "Performance trace",
      status: traceHealthy ? "Passed" : "Failed",
      finding: traceHealthy
        ? `Trace captured with ${audit.trace.discoveredInsights.length} discovered insight types.`
        : "Trace capture was incomplete, so long-task and layout-style evidence is reduced.",
      continued: true
    },
    {
      phase: "5",
      name: "DOM, runtime growth, and rerender churn",
      status:
        counts.domNodeCount !== null || audit.scrollProfile !== null || rerenderHealthy
          ? "Passed"
          : "Partial",
      finding: buildDomAndRerenderFinding(audit, counts),
      continued: true
    },
    {
      phase: "6",
      name: "Memory snapshot",
      status: memoryHealthy ? "Passed" : "Partial",
      finding: memoryHealthy
        ? `Heap graph node count was ${formatMaybeNumber(audit.derivedSignals.heapGraphNodeCount)}.`
        : "Heap snapshot details were not available.",
      continued: true
    }
  ];
}

function buildMetricRows(
  audit: AuditArtifact,
  metrics: {
    consoleErrorCount: number;
    failedRequestCount: number;
    longTaskCount: number | null;
    domNodeCount: number | null;
    iframeCount: number | null;
    imageCount: number | null;
    eagerImagesBelowFold: number | null;
    eagerIframesBelowFold: number | null;
    missingLazyImages: number | null;
    missingLazyIframes: number | null;
    rerenderSignal: RerenderSignal;
  }
): QuickCheckMetricRow[] {
  return [
    {
      metric: "Console errors",
      value: formatMaybeNumber(metrics.consoleErrorCount),
      interpretation:
        metrics.consoleErrorCount >= 5
          ? "Repeated runtime errors need attention."
          : metrics.consoleErrorCount > 0
            ? "There is some console noise worth reviewing."
            : "No obvious runtime error burst was captured."
    },
    {
      metric: "Failed requests",
      value: formatMaybeNumber(metrics.failedRequestCount),
      interpretation:
        metrics.failedRequestCount >= 5
          ? "Critical or repeated request failures may affect content or ads."
          : metrics.failedRequestCount > 0
            ? "A few request failures were present."
            : "No obvious network failure burst was captured."
    },
    {
      metric: "Long-task estimate",
      value: formatMaybeNumber(metrics.longTaskCount),
      interpretation:
        metrics.longTaskCount === null
          ? "Exact long-task count was not exposed by the trace summary."
          : metrics.longTaskCount > 5
            ? "The interaction likely had noticeable main-thread blocking."
            : "The trace did not show a large cluster of inferred long tasks."
    },
    {
      metric: "DOM nodes",
      value: formatMaybeNumber(metrics.domNodeCount),
      interpretation:
        (metrics.domNodeCount ?? 0) >= 1500
          ? "The page is carrying a large live DOM for a quick-check run."
          : "DOM size is not an immediate headline risk from this sample."
    },
    {
      metric: "DOM growth on scroll",
      value: formatMaybeNumber(audit.scrollProfile?.domNodeGrowth),
      interpretation:
        (audit.scrollProfile?.domNodeGrowth ?? 0) >= 150
          ? "The DOM kept growing during scroll, which can increase layout and memory cost as the session continues."
          : audit.scrollProfile?.domNodeGrowth !== null
            ? "DOM growth during scroll was measurable but not extreme in this sample."
            : "DOM growth during scroll could not be measured in this run."
    },
    {
      metric: "Iframes",
      value: formatMaybeNumber(metrics.iframeCount),
      interpretation:
        (metrics.iframeCount ?? 0) >= 10
          ? "Embed or ad iframe pressure is likely meaningful."
          : "Iframe count is present but not unusually high."
    },
    {
      metric: "Images",
      value: formatMaybeNumber(metrics.imageCount),
      interpretation:
        (metrics.imageCount ?? 0) >= 80
          ? "Image-heavy pages should be checked for media weight and lazy loading."
          : "Image count alone is not the strongest risk in this run."
    },
    {
      metric: "Below-fold eager images",
      value: formatMaybeNumber(metrics.eagerImagesBelowFold),
      interpretation:
        (metrics.eagerImagesBelowFold ?? 0) >= 5
          ? "Several images below the first viewport appear to be eager, which is a strong lazy-loading follow-up candidate."
          : (metrics.eagerImagesBelowFold ?? 0) > 0
            ? "A few below-the-fold images appear to be loading eagerly."
            : "No obvious cluster of below-the-fold eager images was detected."
    },
    {
      metric: "Below-fold eager iframes",
      value: formatMaybeNumber(metrics.eagerIframesBelowFold),
      interpretation:
        (metrics.eagerIframesBelowFold ?? 0) >= 2
          ? "Below-the-fold iframe loading looks aggressive and may be adding avoidable network and main-thread work."
          : (metrics.eagerIframesBelowFold ?? 0) > 0
            ? "At least one below-the-fold iframe appears eager."
            : "No obvious cluster of below-the-fold eager iframes was detected."
    },
    {
      metric: "Ad-tech UX pressure",
      value: classifyAdImpactLevel(audit),
      interpretation: buildAdImpactInterpretation(audit)
    },
    {
      metric: "Render churn",
      value: formatRerenderSummary(metrics.rerenderSignal),
      interpretation:
        (metrics.rerenderSignal.mutationCount ?? 0) >= 400 ||
        (metrics.rerenderSignal.longFrameCount ?? 0) >= 4
          ? "The page kept mutating heavily during a short observation window, which can point to unnecessary rerenders or unstable dynamic content."
          : (metrics.rerenderSignal.mutationCount ?? 0) >= 100
            ? "Some render churn was present, but it was not the clearest risk by itself."
            : metrics.rerenderSignal.available
              ? "Short-window mutation churn did not suggest an obvious rerender storm."
              : "Rerender churn could not be measured in this run."
    },
    {
      metric: "Peak scroll heap",
      value: formatBytes(audit.scrollProfile?.peakUsedJsHeapBytes),
      interpretation:
        (audit.scrollProfile?.peakUsedJsHeapBytes ?? 0) >= 180_000_000
          ? "JS heap pressure was high enough during scroll to justify memory follow-up, especially on mobile-class devices."
          : audit.scrollProfile?.peakUsedJsHeapBytes !== null
            ? "Heap usage was measurable during scroll without immediately standing out as extreme."
            : "Live JS heap during scroll was not available in this run."
    },
    {
      metric: "Scroll CLS",
      value: formatMaybeFloat(audit.scrollProfile?.cumulativeLayoutShift),
      interpretation:
        (audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.25
          ? "Layout instability during scroll likely affects user trust and reading flow."
          : "Scroll-time layout shift was present but not the clearest headline issue."
    },
    {
      metric: "Heap graph nodes",
      value: formatMaybeNumber(audit.derivedSignals.heapGraphNodeCount),
      interpretation:
        (audit.derivedSignals.heapGraphNodeCount ?? 0) >= 2_500_000
          ? "Retained heap complexity is high enough to justify memory follow-up."
          : "Retained heap complexity is notable but not the primary headline in isolation."
    }
  ];
}

type LensInputs = {
  consoleErrorCount: number;
  failedRequestCount: number;
  domNodeCount: number | null;
  iframeCount: number | null;
  imageCount: number | null;
  eagerImagesBelowFold: number | null;
  eagerIframesBelowFold: number | null;
  missingLazyImages: number | null;
  missingLazyIframes: number | null;
  longTaskCount: number | null;
  rerenderSignal: RerenderSignal;
  adSignals: ReturnType<typeof collectAdSignals>;
  adImpactScore: number;
  adImpactLevel: string;
  thirdPartyCpuImpact: QuickCheckArtifact["thirdPartyCpuImpact"];
};

function buildUserJourneyImpact(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens[] {
  return [
    buildOpenAndReachContentLens(audit, inputs),
    buildContentStabilizesLens(audit, inputs),
    buildScrollingStaysSmoothLens(audit, inputs),
    buildInteractionsFeelReadyLens(audit, inputs),
    buildSessionStaysAliveLens(audit, inputs)
  ];
}

function extractThirdPartyCpuImpact(
  audit: AuditArtifact
): QuickCheckArtifact["thirdPartyCpuImpact"] {
  const tracePath = audit.trace.tracePath;
  if (!tracePath) {
    return {
      available: false,
      summary: "Main-thread attribution was unavailable because no trace file was recorded for this run.",
      topVendor: null,
      totalAttributedMainThreadTimeMs: null,
      vendors: [],
      notes: "This section requires a saved Chrome performance trace."
    };
  }

  try {
    const content = readFileSync(tracePath, "utf8");
    const parsed = JSON.parse(content) as { traceEvents?: unknown[] };
    const events = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
    const rendererMainThreads = new Set<string>();

    for (const event of events) {
      const record = extractRecord(event);
      if (!record) {
        continue;
      }
      if (record.name === "thread_name") {
        const threadName = getNestedRecord(record, ["args"])?.name;
        const pid = getFiniteNumber(record.pid);
        const tid = getFiniteNumber(record.tid);
        if (threadName === "CrRendererMain" && pid !== null && tid !== null) {
          rendererMainThreads.add(`${pid}:${tid}`);
        }
      }
    }

    const buckets = new Map<string, QuickCheckThirdPartyCpuVendor>();
    let totalAttributedMainThreadTimeMs = 0;

    for (const event of events) {
      const record = extractRecord(event);
      if (!record) {
        continue;
      }

      const pid = getFiniteNumber(record.pid);
      const tid = getFiniteNumber(record.tid);
      if (pid === null || tid === null || !rendererMainThreads.has(`${pid}:${tid}`)) {
        continue;
      }

      const name = typeof record.name === "string" ? record.name : null;
      if (!name || !["FunctionCall", "EvaluateScript", "TimerFire", "EventDispatch"].includes(name)) {
        continue;
      }

      const durationUs = getFiniteNumber(record.dur) ?? getFiniteNumber(record.tdur);
      if (durationUs === null || durationUs <= 0) {
        continue;
      }

      const url =
        getNestedString(record, ["args", "data", "url"]) ??
        getNestedString(record, ["args", "data", "stackTrace", 0, "url"]);
      if (!url) {
        continue;
      }

      const normalized = normalizeVendorUrl(url, audit.request.url);
      if (!normalized || normalized.kind !== "third_party") {
        continue;
      }

      const durationMs = roundTo(durationUs / 1000, 3);
      totalAttributedMainThreadTimeMs += durationMs;

      const existing =
        buckets.get(normalized.vendor) ??
        {
          vendor: normalized.vendor,
          domain: normalized.domain,
          totalMainThreadTimeMs: 0,
          scriptExecutionTimeMs: 0,
          longTaskTimeMs: 0,
          longTaskCount: 0,
          maxTaskMs: 0,
          taskCount: 0,
          confidence: "Confirmed" as const,
          timingWindow: "Captured performance trace",
          likelyUxEffect: ""
        };

      existing.totalMainThreadTimeMs = roundTo(existing.totalMainThreadTimeMs + durationMs, 3);
      existing.taskCount += 1;
      existing.maxTaskMs = Math.max(existing.maxTaskMs, durationMs);
      if (name === "FunctionCall" || name === "EvaluateScript") {
        existing.scriptExecutionTimeMs = roundTo(existing.scriptExecutionTimeMs + durationMs, 3);
      }
      if (durationMs >= 50) {
        existing.longTaskCount += 1;
        existing.longTaskTimeMs = roundTo(existing.longTaskTimeMs + durationMs, 3);
      }
      buckets.set(normalized.vendor, existing);
    }

    const vendors = [...buckets.values()]
      .map((vendor) => ({
        ...vendor,
        likelyUxEffect: describeVendorCpuEffect(vendor)
      }))
      .sort((left, right) => right.totalMainThreadTimeMs - left.totalMainThreadTimeMs)
      .slice(0, 10);

    const topVendor = vendors[0] ?? null;
    if (!topVendor) {
      return {
        available: false,
        summary: "The trace was present, but it did not expose enough directly attributed third-party main-thread events to build a reliable CPU breakdown.",
        topVendor: null,
        totalAttributedMainThreadTimeMs: null,
        vendors: [],
        notes: "This first-pass parser only uses direct script URL attribution from renderer main-thread events."
      };
    }

    return {
      available: true,
      summary: `${topVendor.vendor} was the largest directly attributed third-party main-thread cost in this run at ${formatMaybeNumber(topVendor.totalMainThreadTimeMs)} ms, with ${formatMaybeNumber(topVendor.longTaskCount)} long task(s).`,
      topVendor: topVendor.vendor,
      totalAttributedMainThreadTimeMs: roundTo(totalAttributedMainThreadTimeMs, 3),
      vendors,
      notes:
        "This is a conservative first-pass CPU attribution model based only on directly attributed renderer main-thread events with script URLs. It is directional, not perfect causal proof."
    };
  } catch (error) {
    return {
      available: false,
      summary: "Main-thread attribution could not be parsed from the saved trace for this run.",
      topVendor: null,
      totalAttributedMainThreadTimeMs: null,
      vendors: [],
      notes: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildDecisionIssues(
  audit: AuditArtifact,
  inputs: LensInputs,
  lenses: QuickCheckUserJourneyLens[]
): QuickCheckDecisionIssue[] {
  const issues: QuickCheckDecisionIssue[] = [];
  const cls = audit.scrollProfile?.cumulativeLayoutShift ?? null;
  const domGrowth = audit.scrollProfile?.domNodeGrowth ?? null;
  const peakHeap = audit.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const weakestLens = [...lenses].sort((left, right) => left.impactScore - right.impactScore)[0] ?? null;

  if (
    audit.navigation.status !== "success" ||
    inputs.failedRequestCount >= 5
  ) {
    issues.push({
      title: "Article navigation failed during the audit run",
      type: "Reliability",
      severity: audit.navigation.status === "terminal_error" || audit.navigation.status === "timeout" ? "Critical" : "High",
      priority: audit.navigation.status === "terminal_error" || audit.navigation.status === "timeout" ? "P0" : "P1",
      timing: "Immediate",
      businessImpact: "If this reproduces outside the lab run, it can directly suppress sessions, pageviews, recirculation opportunity, and monetizable article traffic because users may fail to reach content at all.",
      userImpact: "The audit session lost the article open path. If real users see the same behavior, they may hit a broken page, incomplete content, or a browser error state instead of the article.",
      blastRadius: "Single URL",
      confidence: audit.navigation.status !== "success" ? "Strongly Suspected" : "Directional",
      effort: "Medium",
      ownership: "CDN/Network",
      strategicLeverage: "Template Gain",
      recommendedAction: "First validate whether the broken document navigation reproduces outside the audit environment. If it only appears in MCP-backed runs, treat it as a test-environment reliability issue; if it reproduces in normal browsing or repeated runs on this URL, escalate it as a real page/CDN navigation problem before prioritizing deeper optimization work."
    });
  }

  if ((cls ?? 0) >= 0.1 || hasInsight(audit, "ForcedReflow") || (inputs.eagerIframesBelowFold ?? 0) >= 2) {
    issues.push({
      title: "Content stability is likely being disrupted during reading",
      type: "Stability",
      severity: (cls ?? 0) >= 1 ? "Critical" : (cls ?? 0) >= 0.25 ? "High" : "Medium",
      priority: (cls ?? 0) >= 1 ? "P0" : (cls ?? 0) >= 0.25 ? "P1" : "P2",
      timing: (cls ?? 0) >= 0.25 ? "Immediate" : "This Sprint",
      businessImpact: (cls ?? 0) >= 1
        ? "Severe layout instability at this level can materially reduce article completion, recirculation CTR, and confidence in premium editorial surfaces."
        : "Shifting content erodes article quality, reduces reading depth, and can hurt perceived premium experience and ad trust.",
      userImpact: "Readers may lose their place, see content jump, or feel that modules and embeds are loading unpredictably.",
      blastRadius: (inputs.eagerIframesBelowFold ?? 0) >= 2 ? "Template-Level" : "Single URL",
      confidence: cls !== null ? "Confirmed" : "Directional",
      effort: "Medium",
      ownership: (inputs.eagerIframesBelowFold ?? 0) >= 2 || inputs.adImpactScore >= 5 ? "Ads/Monetization" : "Frontend Platform",
      strategicLeverage: "Template Gain",
      recommendedAction: "Reduce layout instability first by reserving slot space, deferring below-the-fold embeds, and removing forced-reflow paths that move content after it appears."
    });
  }

  if ((inputs.longTaskCount ?? 0) >= 5 || (inputs.rerenderSignal.mutationCount ?? 0) >= 100 || hasInsight(audit, "ThirdParties")) {
    issues.push({
      title: "Scroll and reading smoothness are being taxed by runtime churn",
      type: "Responsiveness",
      severity: (inputs.rerenderSignal.mutationCount ?? 0) >= 400 || (inputs.longTaskCount ?? 0) >= 5 ? "High" : "Medium",
      priority: (inputs.rerenderSignal.mutationCount ?? 0) >= 400 || (inputs.longTaskCount ?? 0) >= 5 ? "P1" : "P2",
      timing: "This Sprint",
      businessImpact: "Heavy scroll cost can reduce engagement, article completion, and recirculation on long-form templates by making the reading session feel heavy before users finish the page.",
      userImpact: "Readers may experience sticky scrolling, jittery modules, or heavier interaction as content continues to load.",
      blastRadius: hasInsight(audit, "ThirdParties") ? "Template-Level" : "Single URL",
      confidence: inputs.rerenderSignal.available || inputs.longTaskCount !== null ? "Strongly Suspected" : "Directional",
      effort: "Medium",
      ownership: hasInsight(audit, "ThirdParties") ? "Frontend Platform" : "Page Team",
      strategicLeverage: "Template Gain",
      recommendedAction: "Reduce DOM churn, rerender-heavy components, and third-party main-thread work before tuning smaller cosmetic issues."
    });
  }

  if ((peakHeap ?? 0) >= 180_000_000 || (extractHeapStats(audit).totalBytes ?? 0) >= 200_000_000) {
    issues.push({
      title: "Long-session memory pressure may threaten session stability",
      type: "Memory",
      severity: (peakHeap ?? 0) >= 250_000_000 ? "High" : "Medium",
      priority: (peakHeap ?? 0) >= 250_000_000 ? "P1" : "P2",
      timing: "This Sprint",
      businessImpact: "Memory-heavy sessions can increase renderer eviction risk on constrained devices, hurting return engagement, scroll depth, and longer article-session retention.",
      userImpact: "Users may see the tab get heavier over time, reload unexpectedly, or degrade during longer reading sessions.",
      blastRadius: (domGrowth ?? 0) >= 100 ? "Template-Level" : "Single URL",
      confidence: peakHeap !== null || extractHeapStats(audit).totalBytes !== null ? "Strongly Suspected" : "Directional",
      effort: "Large",
      ownership: "Frontend Platform",
      strategicLeverage: "Platform Multiplier",
      recommendedAction: "Profile retained heap, DOM accumulation, and long-session module growth so memory fixes target reusable template or platform drivers."
    });
  }

  if (inputs.adImpactScore >= 3) {
    issues.push({
      title: "Ads and third-party embeds are a meaningful UX cost center",
      type: "Ad/Third-Party Burden",
      severity: inputs.adImpactScore >= 5 ? "High" : "Medium",
      priority: inputs.adImpactScore >= 5 ? "P1" : "P2",
      timing: "This Sprint",
      businessImpact: "Ad and vendor overhead can lower article completion while also destabilizing viewability and monetization quality on high-scroll templates.",
      userImpact: "Users may see delayed slots, unstable embeds, extra movement, or heavier loading caused by ad-tech and partner code.",
      blastRadius: "Template-Level",
      confidence: weakestLens?.name === "Content Stays Stable" || weakestLens?.name === "Scrolling Feels Smooth" ? "Strongly Suspected" : inputs.adImpactScore >= 5 ? "Strongly Suspected" : "Directional",
      effort: "Medium",
      ownership: "Ads/Monetization",
      strategicLeverage: "Template Gain",
      recommendedAction: "Audit slot timing, refresh behavior, below-the-fold embed loading, and vendor bloat as a monetization-experience tradeoff, not just a page bug."
    });
  }

  const topCpuVendor = inputs.thirdPartyCpuImpact.vendors[0] ?? null;
  if (topCpuVendor && topCpuVendor.totalMainThreadTimeMs >= 100) {
    issues.push({
      title: `${topCpuVendor.vendor} is consuming meaningful main-thread time`,
      type: "Ad/Third-Party Burden",
      severity: topCpuVendor.totalMainThreadTimeMs >= 250 ? "High" : "Medium",
      priority: topCpuVendor.totalMainThreadTimeMs >= 250 ? "P1" : "P2",
      timing: "This Sprint",
      businessImpact: "A single vendor dominating main-thread time can slow article responsiveness and reduce content engagement before users finish the page.",
      userImpact: `This vendor consumed ${formatMaybeNumber(topCpuVendor.totalMainThreadTimeMs)} ms of directly attributed renderer main-thread time and may be contributing to sticky scrolling or delayed module response.`,
      blastRadius: "Template-Level",
      confidence: topCpuVendor.confidence,
      effort: "Medium",
      ownership: classifyVendorOwnership(topCpuVendor.vendor),
      strategicLeverage: "Template Gain",
      recommendedAction: `Profile and defer ${topCpuVendor.vendor} first. It was the largest directly attributed third-party main-thread cost in this trace and is the clearest CPU-specific optimization target in this run.`
    });
  }

  if (issues.length === 0) {
    issues.push({
      title: "No dominant blocker stood out in this run",
      type: "Content Delivery",
      severity: "Low",
      priority: "P3",
      timing: "Monitor",
      businessImpact: "The page does not show an obvious single-run blocker, so the current need is regression monitoring rather than urgent intervention.",
      userImpact: "Users are more likely to experience minor issues than a clear failure state based on this sample.",
      blastRadius: "Single URL",
      confidence: "Strongly Suspected",
      effort: "Small",
      ownership: "Page Team",
      strategicLeverage: "One-Off Fix",
      recommendedAction: "Compare this run against a known-good baseline and watch for regression before escalating work."
    });
  }

  return issues
    .sort((left, right) => decisionRank(right) - decisionRank(left))
    .slice(0, 5);
}

function buildDecisionSummary(
  issues: QuickCheckDecisionIssue[],
  lenses: QuickCheckUserJourneyLens[]
): string {
  const primary = issues[0];
  const weakestLens = [...lenses].sort((left, right) => left.impactScore - right.impactScore)[0];
  if (!primary || !weakestLens) {
    return "This run did not surface a clearly ranked decision signal.";
  }

  return `${primary.priority}: ${primary.title}. The most affected stage of the user journey is ${weakestLens.name.toLowerCase()}. Leadership should treat this as ${primary.timing.toLowerCase()} work owned by ${primary.ownership.toLowerCase()} with ${primary.confidence.toLowerCase()} evidence.`;
}

function buildCriticalAlerts(
  audit: AuditArtifact,
  inputs: LensInputs,
  issues: QuickCheckDecisionIssue[]
): string[] {
  const alerts: string[] = [];
  const cls = audit.scrollProfile?.cumulativeLayoutShift ?? null;

  if (cls !== null && cls >= 1) {
    alerts.push(`CRITICAL UX FAILURE: Scroll CLS reached ${formatMaybeFloat(cls)}. Content instability is severe enough to disrupt reading continuity.`);
  }
  if (audit.navigation.status === "terminal_error" || audit.navigation.status === "timeout") {
    alerts.push(`CRITICAL ACCESS FAILURE: Navigation ended as ${humanizeNavigationStatus(audit.navigation.status)}. Users may fail to reach the article at all if this reproduces outside the lab run.`);
  }
  if ((inputs.failedRequestCount ?? 0) >= 5 && issues.some((issue) => issue.priority === "P0")) {
    alerts.push(`CRITICAL DELIVERY RISK: ${formatMaybeNumber(inputs.failedRequestCount)} failed requests were detected during the run, which may be compromising page-open reliability.`);
  }

  return alerts;
}

function buildOpenAndReachContentLens(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens {
  const traceHealthy = !audit.trace.startTrace.isError && !audit.trace.stopTrace.isError;
  const lighthouseTiming = extractLighthouseTiming(audit);
  const score = clampScore(
    100 -
      navigationPenalty(audit.navigation.status) -
      penaltyFromThreshold(inputs.failedRequestCount, 1, 5, 10, 22) -
      penaltyFromThreshold(inputs.consoleErrorCount, 1, 5, 6, 16) -
      penaltyFromThreshold(lighthouseTiming, 5000, 15000, 8, 18) -
      (traceHealthy ? 0 : 8)
  );
  const metrics: QuickCheckLensMetric[] = [
    lensMetric("Navigation", humanizeNavigationStatus(audit.navigation.status), classifyNavigationStatus(audit.navigation.status)),
    lensMetric("Failed requests", formatMaybeNumber(inputs.failedRequestCount), classifyCount(inputs.failedRequestCount, 1, 5, "No obvious burst of broken requests was captured.", "A few requests failed during page open.", "Broken requests were frequent enough to threaten content availability.")),
    lensMetric("Console errors", formatMaybeNumber(inputs.consoleErrorCount), classifyCount(inputs.consoleErrorCount, 1, 5, "Runtime errors were not a headline blocker during page open.", "Some runtime noise may be affecting startup reliability.", "Runtime errors were repeated enough to threaten a clean open.")),
    lensMetric("Lighthouse timing", formatMaybeNumber(lighthouseTiming), lighthouseTiming === null ? "Snapshot timing was unavailable." : lighthouseTiming <= 5000 ? "Timing stayed in a healthy range for a quick-check sample." : lighthouseTiming <= 15000 ? "Timing suggests a somewhat heavy open path." : "Timing was slow enough to make first arrival feel heavy."),
    lensMetric("Trace coverage", traceHealthy ? "Captured" : "Partial", traceHealthy ? "Load-phase trace evidence was available." : "Trace coverage was partial, so startup interpretation is less certain.")
  ];
  const drivers = collectTopDrivers([
    driver(inputs.failedRequestCount >= 5, `${inputs.failedRequestCount} failed requests during open`),
    driver(inputs.consoleErrorCount >= 5, `${inputs.consoleErrorCount} runtime errors during startup`),
    driver(audit.navigation.status !== "success", `navigation ended as ${audit.navigation.status.replaceAll("_", " ")}`),
    driver(
      lighthouseTiming !== null && lighthouseTiming > 15000,
      lighthouseTiming !== null ? `load timing around ${lighthouseTiming.toFixed(0)} ms` : ""
    ),
    driver(!traceHealthy, "partial trace coverage lowered confidence in the opening path")
  ]);

  return {
    name: "Page Opens Reliably",
    status: lensStatusFromScore(score),
    impactScore: score,
    aiSummary: buildLensSummary(
      score,
      "getting to readable content",
      drivers,
      !traceHealthy || lighthouseTiming === null,
      "Opening-path evidence was partial, so this lens is directionally useful but not complete."
    ),
    primaryDrivers: drivers,
    metrics,
    whyItMatters: "This reflects whether a reader can reach usable content without the page feeling broken, delayed, or incomplete."
  };
}

function buildContentStabilizesLens(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens {
  const cls = audit.scrollProfile?.cumulativeLayoutShift ?? null;
  const score = clampScore(
    100 -
      penaltyFromThreshold(cls, 0.1, 0.25, 18, 34) -
      penaltyFromThreshold(inputs.domNodeCount, 800, 1500, 8, 18) -
      penaltyFromThreshold(inputs.eagerImagesBelowFold, 1, 5, 6, 12) -
      penaltyFromThreshold(inputs.eagerIframesBelowFold, 1, 2, 8, 14) -
      penaltyFromThreshold(inputs.missingLazyImages, 5, 15, 4, 8) -
      penaltyFromThreshold(inputs.missingLazyIframes, 1, 4, 5, 10) -
      (hasInsight(audit, "ForcedReflow") ? 14 : 0) -
      (inputs.adSignals.adWarningCount >= 2 ? 6 : 0)
  );
  const drivers = collectTopDrivers([
    driver((cls ?? 0) >= 0.25, `scroll CLS reached ${formatMaybeFloat(cls)}`),
    driver(hasInsight(audit, "ForcedReflow"), "forced reflow suggests unstable layout work"),
    driver((inputs.eagerIframesBelowFold ?? 0) >= 2, `${formatMaybeNumber(inputs.eagerIframesBelowFold)} eager below-the-fold iframes`),
    driver((inputs.eagerImagesBelowFold ?? 0) >= 5, `${formatMaybeNumber(inputs.eagerImagesBelowFold)} eager below-the-fold images`),
    driver((inputs.domNodeCount ?? 0) >= 1500, `live DOM size reached ${formatMaybeNumber(inputs.domNodeCount)}`)
  ]);

  return {
    name: "Content Stays Stable",
    status: lensStatusFromScore(score),
    impactScore: score,
    aiSummary: buildLensSummary(
      score,
      "content staying visually stable",
      drivers,
      cls === null,
      "Layout-shift evidence was partial, so the stabilization signal has lower confidence."
    ),
    primaryDrivers: drivers,
    metrics: [
      lensMetric("Scroll CLS", formatMaybeFloat(cls), cls === null ? "Scroll-time layout shift was not captured." : cls < 0.1 ? "Visual stability looked healthy during scroll." : cls < 0.25 ? "Some shifting was present during reading or scroll." : "Shifting was high enough to interrupt reading flow."),
      lensMetric("Live DOM", formatMaybeNumber(inputs.domNodeCount), classifyCount(inputs.domNodeCount, 800, 1500, "DOM size did not stand out as a stabilization risk.", "DOM size could add some layout cost.", "DOM size was large enough to amplify layout and style work.")),
      lensMetric("Forced reflow", hasInsight(audit, "ForcedReflow") ? "Present" : "Not flagged", hasInsight(audit, "ForcedReflow") ? "The trace flagged layout-thrashing behavior." : "No explicit forced-reflow insight was flagged."),
      lensMetric("Eager images", formatMaybeNumber(inputs.eagerImagesBelowFold), classifyCount(inputs.eagerImagesBelowFold, 1, 5, "No obvious cluster of eager below-fold images was seen.", "A few below-fold images may be arriving earlier than necessary.", "Several below-fold images appear to load eagerly.")),
      lensMetric("Eager iframes", formatMaybeNumber(inputs.eagerIframesBelowFold), classifyCount(inputs.eagerIframesBelowFold, 1, 2, "Below-fold iframe loading did not stand out.", "At least one below-fold iframe appeared eager.", "Iframe loading below the fold looked aggressive.")),
      lensMetric("Missing lazy hints", formatMaybeNumber(sumNullable(inputs.missingLazyImages, inputs.missingLazyIframes)), "This counts media and embeds missing an explicit loading hint where one was observable.")
    ],
    whyItMatters: "This reflects whether the content settles into place instead of shifting, jumping, or continuing to rearrange itself while the reader tries to follow it."
  };
}

function buildScrollingStaysSmoothLens(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens {
  const domGrowth = audit.scrollProfile?.domNodeGrowth ?? null;
  const maxDomNodes = audit.scrollProfile?.maxDomNodes ?? inputs.domNodeCount;
  const score = clampScore(
    100 -
      penaltyFromThreshold(inputs.longTaskCount, 1, 5, 10, 22) -
      penaltyFromThreshold(inputs.rerenderSignal.mutationCount, 100, 400, 12, 26) -
      penaltyFromThreshold(inputs.rerenderSignal.longFrameCount, 1, 4, 8, 18) -
      penaltyFromThreshold(domGrowth, 100, 300, 10, 18) -
      penaltyFromThreshold(maxDomNodes, 1200, 2500, 6, 14) -
      (hasInsight(audit, "ThirdParties") ? 12 : 0) -
      (hasInsight(audit, "ForcedReflow") ? 10 : 0)
  );
  const drivers = collectTopDrivers([
    driver((inputs.rerenderSignal.mutationCount ?? 0) >= 400, `${formatMaybeNumber(inputs.rerenderSignal.mutationCount)} short-window DOM mutations`),
    driver((inputs.longTaskCount ?? 0) >= 5, `${formatMaybeNumber(inputs.longTaskCount)} inferred long tasks`),
    driver((domGrowth ?? 0) >= 300, `DOM growth reached ${formatMaybeNumber(domGrowth)} during scroll`),
    driver(hasInsight(audit, "ThirdParties"), "third-party trace cost was flagged"),
    driver(hasInsight(audit, "ForcedReflow"), "forced reflow was present during the trace")
  ]);

  return {
    name: "Scrolling Feels Smooth",
    status: lensStatusFromScore(score),
    impactScore: score,
    aiSummary: buildLensSummary(
      score,
      "scrolling and reading staying smooth",
      drivers,
      inputs.longTaskCount === null && !inputs.rerenderSignal.available,
      "Smooth-scroll evidence was partial because long-task or rerender coverage was incomplete."
    ),
    primaryDrivers: drivers,
    metrics: [
      lensMetric("Long tasks", formatMaybeNumber(inputs.longTaskCount), inputs.longTaskCount === null ? "Long-task count was not directly exposed." : inputs.longTaskCount <= 1 ? "The run did not show an obvious long-task cluster." : inputs.longTaskCount <= 5 ? "Some main-thread blocking was inferred." : "Main-thread blocking likely affected scroll smoothness."),
      lensMetric("Render churn", formatRerenderSummary(inputs.rerenderSignal), !inputs.rerenderSignal.available ? "Short-window rerender churn could not be measured." : (inputs.rerenderSignal.mutationCount ?? 0) < 100 ? "Mutation churn did not suggest an obvious rerender storm." : (inputs.rerenderSignal.mutationCount ?? 0) < 400 ? "Some churn was present during a short observation window." : "Mutation churn was heavy enough to threaten smooth scrolling."),
      lensMetric("DOM growth", formatMaybeNumber(domGrowth), classifyCount(domGrowth, 100, 300, "DOM growth during scroll stayed modest.", "DOM growth was measurable during scroll.", "DOM growth during scroll was high enough to keep adding work.")),
      lensMetric("Max DOM", formatMaybeNumber(maxDomNodes), classifyCount(maxDomNodes, 1200, 2500, "Maximum DOM size did not dominate this lens.", "DOM size could be adding some cost mid-session.", "DOM size was large enough to amplify scroll cost.")),
      lensMetric("Third-party cost", hasInsight(audit, "ThirdParties") ? "Present" : "Not flagged", hasInsight(audit, "ThirdParties") ? "Third-party work showed up in the trace." : "No explicit third-party trace insight was flagged."),
      lensMetric("Forced reflow", hasInsight(audit, "ForcedReflow") ? "Present" : "Not flagged", hasInsight(audit, "ForcedReflow") ? "Layout thrash likely contributed to heavier scrolling." : "No explicit forced-reflow trace insight was flagged.")
    ],
    whyItMatters: "This reflects whether reading and scrolling feel fluid instead of sticky, jittery, or heavier as more modules load."
  };
}

function buildInteractionsFeelReadyLens(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens {
  const evaluationHealthy = audit.debugging.evaluation !== null && !audit.debugging.evaluation.isError;
  const score = clampScore(
    100 -
      (evaluationHealthy ? 0 : 18) -
      penaltyFromThreshold(inputs.consoleErrorCount, 1, 5, 8, 20) -
      penaltyFromThreshold(inputs.rerenderSignal.mutationCount, 100, 400, 8, 18) -
      penaltyFromThreshold(inputs.rerenderSignal.longFrameCount, 1, 4, 6, 14) -
      penaltyFromThreshold(inputs.longTaskCount, 1, 5, 6, 16) -
      (audit.navigation.status === "success" ? 0 : 8)
  );
  const drivers = collectTopDrivers([
    driver(!evaluationHealthy, "page-scoped evaluation was incomplete"),
    driver(inputs.consoleErrorCount >= 5, `${inputs.consoleErrorCount} runtime errors could break widgets or modules`),
    driver((inputs.rerenderSignal.mutationCount ?? 0) >= 100, `short-window mutation churn reached ${formatMaybeNumber(inputs.rerenderSignal.mutationCount)}`),
    driver((inputs.longTaskCount ?? 0) >= 5, `${formatMaybeNumber(inputs.longTaskCount)} inferred long tasks`),
    driver((inputs.rerenderSignal.longFrameCount ?? 0) >= 4, `${formatMaybeNumber(inputs.rerenderSignal.longFrameCount)} long frames in the rerender probe`)
  ]);

  return {
    name: "Page Feels Responsive",
    status: lensStatusFromScore(score),
    impactScore: score,
    aiSummary: buildLensSummary(
      score,
      "interactive modules feeling ready and settled",
      drivers,
      !evaluationHealthy,
      "Interaction-readiness evidence was partial because page evaluation did not complete cleanly."
    ),
    primaryDrivers: drivers,
    metrics: [
      lensMetric("Evaluation", evaluationHealthy ? "Available" : "Partial", evaluationHealthy ? "Page evaluation succeeded, so basic client-side state was reachable." : "Evaluation was incomplete, which lowers confidence in interaction-readiness checks."),
      lensMetric("Console errors", formatMaybeNumber(inputs.consoleErrorCount), classifyCount(inputs.consoleErrorCount, 1, 5, "Runtime errors were not the main interaction signal.", "Some runtime noise may affect modules or embeds.", "Runtime errors were frequent enough to threaten interactions.")),
      lensMetric("Render churn", formatRerenderSummary(inputs.rerenderSignal), !inputs.rerenderSignal.available ? "No rerender probe was available." : "This helps show whether components keep mutating after they look loaded."),
      lensMetric("Long tasks", formatMaybeNumber(inputs.longTaskCount), inputs.longTaskCount === null ? "Trace evidence was partial for interaction blocking." : "This indicates whether main-thread pauses may make widgets feel sluggish."),
      lensMetric("Navigation health", humanizeNavigationStatus(audit.navigation.status), classifyNavigationStatus(audit.navigation.status))
    ],
    whyItMatters: "This reflects whether controls, widgets, and dynamic modules feel settled enough to use instead of lagging, breaking, or continuing to reshuffle themselves."
  };
}

function buildSessionStaysAliveLens(
  audit: AuditArtifact,
  inputs: LensInputs
): QuickCheckUserJourneyLens {
  const heapStats = extractHeapStats(audit);
  const compiledCodeBytes = extractCompiledCodeBytes(audit);
  const peakHeap = audit.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const domGrowth = audit.scrollProfile?.domNodeGrowth ?? null;
  const score = clampScore(
    100 -
      penaltyFromThreshold(peakHeap, 150_000_000, 250_000_000, 14, 28) -
      penaltyFromThreshold(heapStats.totalBytes, 200_000_000, 300_000_000, 12, 22) -
      penaltyFromThreshold(heapStats.nodeCount, 2_500_000, 5_000_000, 8, 16) -
      penaltyFromThreshold(compiledCodeBytes, 40_000_000, 80_000_000, 6, 12) -
      penaltyFromThreshold(domGrowth, 100, 300, 6, 12) -
      penaltyFromThreshold(inputs.adImpactScore, 3, 5, 4, 8) -
      (hasInsight(audit, "ThirdParties") ? 8 : 0)
  );
  const drivers = collectTopDrivers([
    driver((peakHeap ?? 0) >= 180_000_000, `peak scroll heap reached ${formatBytes(peakHeap)}`),
    driver((heapStats.totalBytes ?? 0) >= 200_000_000, `heap snapshot retained about ${formatBytes(heapStats.totalBytes)}`),
    driver((heapStats.nodeCount ?? 0) >= 2_500_000, `heap graph reached ${formatMaybeNumber(heapStats.nodeCount)} nodes`),
    driver((domGrowth ?? 0) >= 100, `DOM kept growing by ${formatMaybeNumber(domGrowth)} nodes during scroll`),
    driver(inputs.adImpactScore >= 5, `ad impact score reached ${formatMaybeNumber(inputs.adImpactScore)}`)
  ]);

  return {
    name: "Session Stays Stable",
    status: lensStatusFromScore(score),
    impactScore: score,
    aiSummary: buildLensSummary(
      score,
      "longer sessions staying stable on memory-constrained devices",
      drivers,
      peakHeap === null && heapStats.totalBytes === null,
      "Memory evidence was partial, so session-stability risk is directional rather than definitive."
    ),
    primaryDrivers: drivers,
    metrics: [
      lensMetric("Peak scroll heap", formatBytes(peakHeap), peakHeap === null ? "Live heap sampling during scroll was unavailable." : peakHeap < 150_000_000 ? "Heap usage stayed in a modest range for this sample." : peakHeap < 250_000_000 ? "Heap pressure was meaningful during scroll." : "Heap pressure was high enough to threaten long-session stability."),
      lensMetric("Retained heap", formatBytes(heapStats.totalBytes), heapStats.totalBytes === null ? "Heap snapshot total was unavailable." : heapStats.totalBytes < 200_000_000 ? "Retained heap was measurable without standing out as extreme." : heapStats.totalBytes < 300_000_000 ? "Retained heap was large enough to justify follow-up." : "Retained heap was very high for a content session sample."),
      lensMetric("Heap graph nodes", formatMaybeNumber(heapStats.nodeCount), classifyCount(heapStats.nodeCount, 2_500_000, 5_000_000, "Heap graph complexity did not dominate this lens.", "Heap graph complexity was meaningful.", "Heap graph complexity was high enough to suggest retention risk.")),
      lensMetric("Compiled code", formatBytes(compiledCodeBytes), compiledCodeBytes === null ? "Compiled-code retention was unavailable." : "This helps show whether shipped JavaScript may be contributing to long-session memory cost."),
      lensMetric("DOM growth", formatMaybeNumber(domGrowth), classifyCount(domGrowth, 100, 300, "DOM growth did not stand out as a session-stability risk.", "DOM growth could gradually raise memory and layout cost.", "DOM growth was high enough to keep increasing session cost.")),
      lensMetric("Ad impact", `${formatMaybeNumber(inputs.adImpactScore)} (${inputs.adImpactLevel})`, inputs.adImpactScore >= 5 ? "Ads and embeds look like a meaningful contributor to long-session pressure." : "Ads were not the only memory driver in this sample.")
    ],
    whyItMatters: "This reflects whether the tab is likely to remain stable over longer reading sessions instead of getting heavier, leaking state, or risking eviction on constrained devices."
  };
}

function buildCommonViewpointSummary(lenses: QuickCheckUserJourneyLens[]): string | null {
  if (lenses.length === 0) {
    return null;
  }

  const ordered = [...lenses].sort((left, right) => left.impactScore - right.impactScore);
  const primary = ordered[0];
  if (!primary) {
    return null;
  }
  const firstDriver = primary.primaryDrivers[0] ?? "the combined signal mix in this run";
  const firstAction = firstLensAction(primary.name);
  return `${primary.name} is the most affected stage of the journey in this run. The strongest evidence was ${firstDriver}. Fix ${firstAction} first, then rerun the same quick check to confirm the experience improves.`;
}

function firstLensAction(name: QuickCheckUserJourneyLens["name"]): string {
  switch (name) {
    case "Page Opens Reliably":
      return "startup reliability and broken request paths";
    case "Content Stays Stable":
      return "layout stability and eager below-the-fold loading";
    case "Scrolling Feels Smooth":
      return "scroll-time DOM churn and third-party main-thread cost";
    case "Page Feels Responsive":
      return "runtime errors and modules that keep mutating after load";
    case "Session Stays Stable":
      return "memory pressure, retained heap, and long-session DOM growth";
  }
}

function lensMetric(label: string, value: string, interpretation: string): QuickCheckLensMetric {
  return { label, value, interpretation };
}

function lensStatusFromScore(score: number): QuickCheckLensStatus {
  if (score >= 85) {
    return "Healthy";
  }
  if (score >= 65) {
    return "Watch";
  }
  if (score >= 40) {
    return "Needs Attention";
  }
  return "Blocked";
}

function buildLensSummary(
  score: number,
  focusArea: string,
  drivers: string[],
  evidencePartial: boolean,
  partialNote: string
): string {
  const status = lensStatusFromScore(score);
  const lead =
    status === "Healthy"
      ? `The signal for ${focusArea} looks healthy in this run.`
      : status === "Watch"
        ? `The signal for ${focusArea} looks mostly workable, but there are issues worth watching.`
        : status === "Needs Attention"
          ? `The signal for ${focusArea} shows meaningful user-experience risk.`
          : `The signal for ${focusArea} looks severe enough to plausibly affect real users.`;
  const driverText =
    drivers.length > 0
      ? ` The clearest drivers were ${drivers.slice(0, 2).join(" and ")}.`
      : " No single dominant driver stood out more than the combined evidence.";
  const suffix = evidencePartial ? ` ${partialNote}` : "";
  return `${lead}${driverText}${suffix}`;
}

function collectTopDrivers(candidates: Array<string | null>): string[] {
  return candidates.filter((value): value is string => Boolean(value)).slice(0, 3);
}

function driver(condition: boolean, description: string): string | null {
  return condition ? description : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function penaltyFromThreshold(
  value: number | null,
  watchMin: number,
  attentionMin: number,
  watchPenalty: number,
  attentionPenalty: number
): number {
  if (value === null) {
    return 0;
  }
  if (value >= attentionMin) {
    return attentionPenalty;
  }
  if (value >= watchMin) {
    return watchPenalty;
  }
  return 0;
}

function navigationPenalty(status: AuditArtifact["navigation"]["status"]): number {
  if (status === "terminal_error" || status === "timeout") {
    return 70;
  }
  if (status !== "success") {
    return 18;
  }
  return 0;
}

function humanizeNavigationStatus(status: AuditArtifact["navigation"]["status"]): string {
  return status.replaceAll("_", " ");
}

function classifyNavigationStatus(status: AuditArtifact["navigation"]["status"]): string {
  if (status === "success") {
    return "Navigation completed successfully.";
  }
  if (status === "partial_load") {
    return "Navigation only partially completed, so startup confidence is lower.";
  }
  return "Navigation did not complete cleanly.";
}

function classifyCount(
  value: number | null,
  watchMin: number,
  attentionMin: number,
  healthyText: string,
  watchText: string,
  attentionText: string
): string {
  if (value === null) {
    return "This signal was not captured in this run.";
  }
  if (value >= attentionMin) {
    return attentionText;
  }
  if (value >= watchMin) {
    return watchText;
  }
  return healthyText;
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}

function classifyOverallStatus({
  audit,
  consoleErrorCount,
  failedRequestCount,
  domNodeCount,
  rerenderSignal
}: {
  audit: AuditArtifact;
  consoleErrorCount: number;
  failedRequestCount: number;
  domNodeCount: number | null;
  rerenderSignal: RerenderSignal;
}): QuickCheckOverallStatus {
  if (audit.navigation.status === "terminal_error" || audit.navigation.status === "timeout") {
    return "Blocked";
  }
  if (
    consoleErrorCount >= 5 ||
    failedRequestCount >= 5 ||
    (audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.25 ||
    (domNodeCount ?? 0) >= 2500 ||
    (rerenderSignal.mutationCount ?? 0) >= 400 ||
    (rerenderSignal.longFrameCount ?? 0) >= 4
  ) {
    return "Needs Attention";
  }
  if (
    consoleErrorCount > 0 ||
    failedRequestCount > 0 ||
    (audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1 ||
    (domNodeCount ?? 0) >= 1200 ||
    (rerenderSignal.mutationCount ?? 0) >= 100 ||
    audit.warnings.length > 0
  ) {
    return "Watch";
  }
  return "Healthy";
}

function deriveConfidenceLevel(audit: AuditArtifact): "High" | "Medium" | "Low" {
  const availableSignals = [
    audit.debugging.consoleMessages !== null && !audit.debugging.consoleMessages.isError,
    audit.debugging.networkRequests !== null && !audit.debugging.networkRequests.isError,
    audit.debugging.evaluation !== null && !audit.debugging.evaluation.isError,
    !audit.trace.startTrace.isError && !audit.trace.stopTrace.isError,
    audit.memory?.summary !== null && !(audit.memory?.summary?.isError ?? true)
  ].filter(Boolean).length;

  if (availableSignals >= 4) {
    return "High";
  }
  if (availableSignals >= 2) {
    return "Medium";
  }
  return "Low";
}

function buildPlainEnglishSummary(
  overallStatus: QuickCheckOverallStatus,
  audit: AuditArtifact,
  counts: {
    consoleErrorCount: number;
    failedRequestCount: number;
    domNodeCount: number | null;
    rerenderSignal: RerenderSignal;
  }
): string {
  if (overallStatus === "Blocked") {
    return "The page could not be validated confidently because the browser session did not complete a healthy page-open sequence.";
  }

  const drivers: string[] = [];
  if (counts.consoleErrorCount > 0) {
    drivers.push(`${counts.consoleErrorCount} console errors`);
  }
  if (counts.failedRequestCount > 0) {
    drivers.push(`${counts.failedRequestCount} failed requests`);
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    drivers.push(`scroll CLS of ${formatMaybeFloat(audit.scrollProfile?.cumulativeLayoutShift)}`);
  }
  if ((counts.domNodeCount ?? 0) >= 1200) {
    drivers.push(`a live DOM size of ${formatMaybeNumber(counts.domNodeCount)}`);
  }
  if ((counts.rerenderSignal.mutationCount ?? 0) >= 100) {
    drivers.push(
      `render churn with ${formatMaybeNumber(counts.rerenderSignal.mutationCount)} short-window DOM mutations`
    );
  }

  const suffix =
    drivers.length > 0
      ? ` The clearest risk signals were ${drivers.slice(0, 3).join(", ")}.`
      : " The run did not surface a single dominant browser-level risk signal.";

  if (overallStatus === "Needs Attention") {
    return `This page showed meaningful browser-level performance or stability risk in the quick check.${suffix}`;
  }
  if (overallStatus === "Watch") {
    return `This page loaded and ran, but the quick check surfaced issues worth monitoring before calling it healthy.${suffix}`;
  }
  return `This quick check did not surface an immediate high-severity browser-level problem.${suffix}`;
}

function deriveTopRisk(
  audit: AuditArtifact,
  counts: {
    consoleErrorCount: number;
    failedRequestCount: number;
    domNodeCount: number | null;
    rerenderSignal: RerenderSignal;
  }
): string {
  if (counts.failedRequestCount >= 5) {
    return "Repeated failed requests may be breaking parts of the page or delaying critical content.";
  }
  if (counts.consoleErrorCount >= 5) {
    return "Repeated client-side errors may be degrading page reliability and interaction quality.";
  }
  if ((counts.rerenderSignal.mutationCount ?? 0) >= 400) {
    return "The page showed heavy short-window DOM churn, which can indicate unnecessary rerenders or unstable dynamic modules.";
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.25) {
    return "Layout instability during scroll appears high enough to affect reading or tapping confidence.";
  }
  if ((counts.domNodeCount ?? 0) >= 1500) {
    return "The page is carrying a large live DOM, which increases layout, style, and memory cost.";
  }
  return "The quick check did not reveal one single dominant failure, but the page still warrants normal regression review.";
}

function deriveUserImpact(
  overallStatus: QuickCheckOverallStatus,
  audit: AuditArtifact,
  counts: {
    consoleErrorCount: number;
    failedRequestCount: number;
    rerenderSignal: RerenderSignal;
  }
): string {
  if (overallStatus === "Blocked") {
    return "Users may see a broken or incomplete experience if this behavior reproduces outside the lab run.";
  }
  if (counts.failedRequestCount > 0) {
    return "Users may see missing content, delayed embeds, or inconsistent third-party behavior.";
  }
  if (counts.consoleErrorCount > 0) {
    return "Users may experience rough interactions, broken widgets, or page instability even if the first paint looks acceptable.";
  }
  if ((counts.rerenderSignal.mutationCount ?? 0) >= 100) {
    return "Users may notice jittery modules, unstable content blocks, or extra work during scroll and idle time.";
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    return "Users may notice shifting content while reading or scrolling.";
  }
  return "The primary impact from this run is lower confidence rather than clear user-facing breakage.";
}

function deriveRecommendedAction(audit: AuditArtifact): string {
  if (hasInsight(audit, "ForcedReflow")) {
    return "Prioritize layout-thrashing and third-party script cleanup, then rerun the same quick check for comparison.";
  }
  if ((extractRerenderSignal(audit).mutationCount ?? 0) >= 100) {
    return "Inspect components or embeds that keep mutating after load, then rerun the quick check to confirm the page settles more cleanly.";
  }
  if (hasInsight(audit, "ThirdParties")) {
    return "Review the heaviest third-party domains first and defer or remove non-critical scripts.";
  }
  return "Use the captured console, network, and trace evidence to validate the main regression driver, then rerun against a baseline.";
}

function buildLimitations(audit: AuditArtifact): string {
  const limitations = [
    "This is a desktop-Chrome-backed diagnostic workflow, not a guarantee of mobile device stability.",
    "A single lab-style run does not replace real-user monitoring or production analytics."
  ];

  if (audit.memory?.summary === null) {
    limitations.push("Memory snapshot evidence was not available in this run.");
  }
  if (audit.debugging.evaluation === null || audit.debugging.evaluation.isError) {
    limitations.push("Page-scoped DOM/runtime evaluation was incomplete.");
  }
  if (audit.trace.stopTrace.isError) {
    limitations.push("Trace capture was incomplete, so long-task and layout-style details are reduced.");
  }

  return limitations.join(" ");
}

function buildConsoleSummary(audit: AuditArtifact): string {
  if (audit.debugging.consoleMessageDetails.length === 0) {
    return "No detailed console messages were captured.";
  }

  return audit.debugging.consoleMessageDetails
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${truncateText(cleanWhitespace(item.text), 600)}`)
    .join("\n\n");
}

function buildNetworkSummary(audit: AuditArtifact): string {
  const text = audit.debugging.networkRequests?.text;
  if (!text) {
    return "No network request summary was available.";
  }

  const topDomains = summarizeDomainsFromText(text);
  const failed = countFailedRequests(audit);
  const lines = [
    `Failed request estimate: ${failed}`,
    topDomains.length > 0 ? `Frequent domains: ${topDomains.join(", ")}` : "Frequent domains could not be summarized from the captured text."
  ];

  return `${lines.join("\n")}\n\n${truncateText(cleanWhitespace(text), 2500)}`;
}

function buildTraceSummary(audit: AuditArtifact): string {
  const sections: string[] = [];
  const traceSummary =
    extractRecord(audit.trace.stopTrace.structuredContent)?.traceSummary ?? audit.trace.stopTrace.text;
  if (traceSummary) {
    sections.push(truncateText(cleanWhitespace(String(traceSummary)), 2500));
  }
  for (const insight of audit.trace.analyzedInsights.slice(0, 3)) {
    sections.push(`Insight: ${getInsightName(insight.arguments) ?? "unknown"}\n${truncateText(cleanWhitespace(insight.text), 1200)}`);
  }
  return sections.join("\n\n");
}

function buildRecommendations(
  audit: AuditArtifact,
  overallStatus: QuickCheckOverallStatus,
  counts: {
    consoleErrorCount: number;
    failedRequestCount: number;
    domNodeCount: number | null;
    rerenderSignal: RerenderSignal;
  }
): string[] {
  const recommendations = new Set<string>();

  if (overallStatus === "Blocked") {
    recommendations.add("Stabilize page-open reliability first, then rerun the same quick check before interpreting deeper performance data.");
  }
  if (counts.consoleErrorCount > 0) {
    recommendations.add("Fix repeated console and runtime errors before drawing conclusions from later performance phases.");
  }
  if (counts.failedRequestCount > 0) {
    recommendations.add("Review failed requests and separate critical content failures from noisy third-party failures.");
  }
  if (hasInsight(audit, "ThirdParties")) {
    recommendations.add("Reduce or defer the heaviest third-party scripts, especially ad-tech, embeds, and analytics that dominate transfer size or main-thread time.");
  }
  const topCpuVendor = extractThirdPartyCpuImpact(audit).vendors[0];
  if (topCpuVendor && topCpuVendor.totalMainThreadTimeMs >= 100) {
    recommendations.add(`Profile and defer ${topCpuVendor.vendor} first, since it was the largest directly attributed third-party main-thread cost in this trace.`);
  }
  if (computeAdImpactScore(audit) >= 5) {
    recommendations.add("Audit ad slot loading, refresh behavior, and below-the-fold embed timing first, since ads appear to be a meaningful part of the user-experience cost.");
  }
  if (hasInsight(audit, "ForcedReflow")) {
    recommendations.add("Investigate forced reflow and layout thrashing paths before pursuing smaller cosmetic optimizations.");
  }
  if ((counts.domNodeCount ?? 0) >= 1200 || (audit.scrollProfile?.domNodeGrowth ?? 0) >= 100) {
    recommendations.add("Inspect DOM growth during interaction and lazy loading, especially if the page accumulates modules or embeds while scrolling.");
  }
  if (
    (extractEvaluationNumber(audit, "eagerImagesBelowFold") ?? 0) >= 5 ||
    (extractEvaluationNumber(audit, "eagerIframesBelowFold") ?? 0) >= 2
  ) {
    recommendations.add("Lazy-load below-the-fold images and embeds that do not need to start immediately on first view.");
  }
  if ((counts.rerenderSignal.mutationCount ?? 0) >= 100) {
    recommendations.add("Review components, ads, and client-side widgets that keep mutating the DOM after initial load, especially if they update without visible user intent.");
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    recommendations.add("Prioritize layout stability improvements for lazy-loaded content, ad slots, fonts, and embed placeholders.");
  }
  if (recommendations.size === 0) {
    recommendations.add("Rerun this quick check against a known-good baseline so small regressions are easier to interpret.");
  }

  return [...recommendations];
}

function mergeRecommendations(primary: string[], fallback: string[]): string[] {
  const merged = new Set<string>();
  for (const item of primary) {
    if (item.trim()) {
      merged.add(item);
    }
  }
  for (const item of fallback) {
    if (item.trim()) {
      merged.add(item);
    }
  }
  return [...merged];
}

function buildMcpPrompt(url: string, flowDescription?: string): string {
  return [
    `Run a quick page performance check for ${url} and produce a single self-contained HTML report.`,
    "",
    "Use a phased, fail-soft approach:",
    "1. Open the page and confirm whether it loads.",
    "2. Collect console errors and warnings.",
    "3. Collect network request summary, failed requests, and top domains.",
    `4. Record a performance trace while loading and performing this flow: ${flowDescription ?? "Open the page, allow it to settle, and perform a short representative interaction or scroll."}`,
    "5. Measure DOM size, iframe count, image count, and obvious runtime growth where available.",
    "6. Continue to the next phase if any individual phase fails, and mark that phase as Failed or Partial in the report.",
    "",
    "The report must start with a non-technical executive summary, then include what was tested, phase results, key metrics, evidence, recommendations, and appendix."
  ].join("\n");
}

export function renderQuickCheckHtml(artifact: QuickCheckArtifact): string {
  const statusClass = `status-${artifact.overallStatus.toLowerCase().replaceAll(" ", "-")}`;
  const statusBadgeClass = `badge-${artifact.overallStatus.toLowerCase().replaceAll(" ", "-")}`;
  const sectionSummaries = buildSectionSummaries(artifact);
  const aiScriptPlan = artifact.rawAudit.aiOutput?.summary?.scriptActionPlan ?? [];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page Performance Quick Check Report</title>
  <style>
    :root {
      --bg: #f5f2ea;
      --panel: #fffdfa;
      --panel-strong: #fff8ed;
      --text: #1d1b19;
      --muted: #625d57;
      --line: #ddd3c4;
      --line-strong: #c8bba8;
      --soft: #f7f2ea;
      --header: #efe6d9;
      --healthy: #166534;
      --watch: #a16207;
      --attention: #b45309;
      --blocked: #991b1b;
      --healthy-bg: #ecfdf3;
      --watch-bg: #fff7e6;
      --attention-bg: #fff4e5;
      --blocked-bg: #fef2f2;
      --shadow: 0 10px 30px rgba(36, 29, 20, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(247, 221, 183, 0.25), transparent 32%),
        linear-gradient(180deg, #f8f4ee 0%, var(--bg) 100%);
      color: var(--text);
      font-family: "SF Pro Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.55;
    }
    main {
      max-width: 1160px;
      margin: 0 auto;
      padding: 32px 18px 56px;
    }
    h1, h2, h3 { margin: 0 0 10px; line-height: 1.15; }
    h1 { font-size: 2.3rem; letter-spacing: -0.03em; }
    h2 { font-size: 1.35rem; }
    h3 { font-size: 1rem; }
    p { margin: 0 0 12px; }
    .small { color: var(--muted); font-size: 12px; }
    .eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 10px; }
    .page-meta { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
    .card {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px 20px;
      margin: 18px 0;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .summary {
      background: linear-gradient(180deg, var(--panel-strong), var(--panel));
      border-left: 6px solid var(--line-strong);
    }
    .status-healthy { color: var(--healthy); font-weight: 700; }
    .status-watch { color: var(--watch); font-weight: 700; }
    .status-needs-attention { color: var(--attention); font-weight: 700; }
    .status-blocked { color: var(--blocked); font-weight: 700; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge-healthy { color: var(--healthy); background: var(--healthy-bg); border-color: #bbf7d0; }
    .badge-watch { color: var(--watch); background: var(--watch-bg); border-color: #fcd34d; }
    .badge-needs-attention { color: var(--attention); background: var(--attention-bg); border-color: #fdba74; }
    .badge-blocked { color: var(--blocked); background: var(--blocked-bg); border-color: #fca5a5; }
    .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0 18px; }
    .executive-chip {
      background: rgba(255,255,255,0.72);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
    }
    .executive-chip .label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
    .executive-chip .value { font-size: 1rem; font-weight: 700; }
    .table-wrap { overflow-x: auto; margin-top: 12px; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 12px 0; font-size: 14px; background: white; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    th { background: var(--header); }
    tbody tr:nth-child(even) td { background: rgba(247, 242, 234, 0.55); }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; }
    .metric {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: linear-gradient(180deg, #fff, var(--soft));
    }
    .metric .value { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
    .scan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .signal-card {
      border: 1px solid var(--line);
      border-left-width: 5px;
      border-radius: 14px;
      padding: 14px;
      background: #fff;
    }
    .signal-card.critical { border-left-color: var(--blocked); background: linear-gradient(180deg, #fff, var(--blocked-bg)); }
    .signal-card.watch { border-left-color: var(--watch); background: linear-gradient(180deg, #fff, var(--watch-bg)); }
    .signal-card.healthy { border-left-color: var(--healthy); background: linear-gradient(180deg, #fff, var(--healthy-bg)); }
    .signal-card.info { border-left-color: var(--line-strong); background: linear-gradient(180deg, #fff, var(--soft)); }
    .signal-card .label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .signal-card .value {
      font-size: 1.45rem;
      font-weight: 850;
      line-height: 1.15;
      margin: 6px 0;
    }
    .signal-card .summary { background: transparent; border-left: 0; box-shadow: none; padding: 0; margin: 0; color: var(--muted); font-size: 13px; }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .detail-panel {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: #fff;
    }
    .detail-panel h3 { margin-bottom: 8px; }
    pre {
      background: #fbfaf8;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      overflow-x: auto;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.6;
    }
    details { margin-top: 12px; border: 1px solid var(--line); border-radius: 14px; background: #fcfbf8; }
    details[open] { background: #fffdf9; }
    summary.accordion-summary {
      cursor: pointer;
      padding: 13px 15px;
      font-weight: 700;
      list-style: none;
    }
    summary.accordion-summary::-webkit-details-marker { display: none; }
    .accordion-body { padding: 0 15px 15px; }
    .section-summary { margin: 6px 0 12px; color: var(--muted); font-size: 15px; }
    .lens-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 12px; }
    .lens-card { border: 1px solid var(--line); border-radius: 16px; padding: 14px; background: linear-gradient(180deg, #fff, var(--soft)); }
    .lens-meta { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 8px; }
    .lens-score { font-size: 28px; font-weight: 700; }
    .lens-drivers { margin: 8px 0 0; padding-left: 18px; }
    .decision-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; }
    .decision-card { border: 1px solid var(--line); border-radius: 16px; padding: 14px; background: linear-gradient(180deg, #fff, #fffaf2); }
    .decision-title { font-weight: 700; margin-bottom: 6px; }
    .alert { border: 1px solid #fca5a5; background: linear-gradient(180deg, #fff1f1, #fef2f2); color: #991b1b; border-radius: 14px; padding: 14px; margin: 12px 0; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35); }
    .priority-p0, .priority-p1, .priority-p2, .priority-p3 {
      display: inline-flex;
      align-items: center;
      padding: 4px 9px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 12px;
      border: 1px solid transparent;
    }
    .priority-p0 { color: #991b1b; background: #fef2f2; border-color: #fca5a5; }
    .priority-p1 { color: #b45309; background: #fff7e6; border-color: #fdba74; }
    .priority-p2 { color: #1d4ed8; background: #eff6ff; border-color: #93c5fd; }
    .priority-p3 { color: #475569; background: #f8fafc; border-color: #cbd5e1; }
    .journey-summary-table td:first-child, .journey-summary-table th:first-child { white-space: nowrap; }
    @media (max-width: 760px) {
      main { padding: 22px 12px 44px; }
      h1 { font-size: 1.8rem; }
      .card { padding: 16px; }
      .executive-grid, .metric-grid, .lens-grid, .decision-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
  <div class="eyebrow">Performance Diagnostic</div>
  <h1>Page Performance Quick Check Report</h1>
  <p class="page-meta">Generated: ${escapeHtml(artifact.createdAt)} | Environment: ${escapeHtml(artifact.environment.emulation)} | Viewport: ${escapeHtml(artifact.request.deviceProfile)} | Browser: ${escapeHtml(artifact.environment.collector)}</p>

  <section class="card summary">
    <h2>1. Executive Summary</h2>
    ${artifact.criticalAlerts.map((alert) => `<div class="alert">${escapeHtml(alert)}</div>`).join("")}
    <div class="executive-grid">
      <div class="executive-chip"><span class="label">Overall Status</span><span class="value"><span class="badge ${statusBadgeClass}">${escapeHtml(artifact.overallStatus)}</span></span></div>
      <div class="executive-chip"><span class="label">Decision Summary</span><span class="value">${escapeHtml(artifact.decisionIssues[0]?.priority ?? "P3")}</span></div>
      <div class="executive-chip"><span class="label">Confidence</span><span class="value">${escapeHtml(artifact.confidenceLevel)}</span></div>
      <div class="executive-chip"><span class="label">Primary Owner</span><span class="value">${escapeHtml(artifact.decisionIssues[0]?.ownership ?? "Page Team")}</span></div>
    </div>
    <p>${escapeHtml(artifact.plainEnglishSummary)}</p>
    <div class="table-wrap"><table>
      <tr><th>Top risk</th><td>${escapeHtml(artifact.topRisk)}</td></tr>
      <tr><th>Likely user impact</th><td>${escapeHtml(artifact.userImpact)}</td></tr>
      <tr><th>Recommended action</th><td>${escapeHtml(artifact.recommendedAction)}</td></tr>
      <tr><th>Confidence</th><td>${escapeHtml(artifact.confidenceLevel)}</td></tr>
    </table></div>
  </section>

  <section class="card">
    <h2>2. Decision Layer</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.decisionLayer)}</p>
    <p>${escapeHtml(artifact.decisionSummary)}</p>
    ${renderAccordion(
      "Expand Decision Layer",
      `<div class="decision-grid">
        ${artifact.decisionIssues
          .map(
            (issue) => `<div class="decision-card">
              <div class="decision-title">${escapeHtml(issue.title)}</div>
              <p><span class="priority-${escapeHtml(issue.priority).toLowerCase()}">${escapeHtml(issue.priority)}</span> | <strong>${escapeHtml(issue.severity)}</strong> | ${escapeHtml(issue.type)} | ${escapeHtml(issue.timing)}</p>
              <p>${escapeHtml(issue.businessImpact)}</p>
              <p class="small"><strong>Owner:</strong> ${escapeHtml(issue.ownership)} | <strong>Confidence:</strong> ${escapeHtml(issue.confidence)} | <strong>Blast radius:</strong> ${escapeHtml(issue.blastRadius)}</p>
              <p class="small"><strong>Next action:</strong> ${escapeHtml(issue.recommendedAction)}</p>
            </div>`
          )
          .join("")}
      </div>
      <div class="table-wrap"><table>
        <tr><th>Issue</th><th>Priority</th><th>Severity</th><th>Type</th><th>Timing</th><th>Business Impact</th><th>User Impact</th><th>Blast Radius</th><th>Confidence</th><th>Effort</th><th>Ownership</th><th>Strategic Leverage</th></tr>
        ${artifact.decisionIssues
          .map(
            (issue) => `<tr><td>${escapeHtml(issue.title)}</td><td><span class="priority-${escapeHtml(issue.priority).toLowerCase()}">${escapeHtml(issue.priority)}</span></td><td>${escapeHtml(issue.severity)}</td><td>${escapeHtml(issue.type)}</td><td>${escapeHtml(issue.timing)}</td><td>${escapeHtml(issue.businessImpact)}</td><td>${escapeHtml(issue.userImpact)}</td><td>${escapeHtml(issue.blastRadius)}</td><td>${escapeHtml(issue.confidence)}</td><td>${escapeHtml(issue.effort)}</td><td>${escapeHtml(issue.ownership)}</td><td>${escapeHtml(issue.strategicLeverage)}</td></tr>`
          )
          .join("")}
      </table></div>`,
      true
    )}
  </section>

  <section class="card">
    <h2>3. User Journey Perspective</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.userJourneyPerspective)}</p>
    <p>${escapeHtml(artifact.commonViewpointSummary)}</p>
    <div class="table-wrap"><table class="journey-summary-table">
      <tr><th>Journey Stage</th><th>Score</th><th>Status</th><th>Primary Issue</th></tr>
      ${artifact.userJourneyImpact
        .map(
          (lens) => `<tr><td>${escapeHtml(lens.name)}</td><td>${lens.impactScore}</td><td>${escapeHtml(lens.status)}</td><td>${escapeHtml(lens.primaryDrivers[0] ?? "No single dominant driver stood out.")}</td></tr>`
        )
        .join("")}
    </table></div>
    ${renderAccordion(
      "Expand User Journey Perspective",
      `<div class="lens-grid">
        ${artifact.userJourneyImpact
          .map(
            (lens) => `<div class="lens-card">
              <div class="lens-meta">
                <div><strong>${escapeHtml(lens.name)}</strong><div class="${`status-${lens.status.toLowerCase().replaceAll(" ", "-")}`}">${escapeHtml(lens.status)}</div></div>
                <div class="lens-score">${lens.impactScore}</div>
              </div>
              <p>${escapeHtml(lens.aiSummary)}</p>
              ${renderAccordion(
                `Expand ${lens.name}`,
                `<p class="small"><strong>Why it matters:</strong> ${escapeHtml(lens.whyItMatters)}</p>
                <p class="small"><strong>Top drivers:</strong> ${escapeHtml(lens.primaryDrivers.join(", ") || "No single dominant driver stood out.")}</p>
                <div class="table-wrap"><table>
                  <tr><th>Metric</th><th>Value</th><th>Interpretation</th></tr>
                  ${lens.metrics
                    .map(
                      (metric) => `<tr><td>${escapeHtml(metric.label)}</td><td>${escapeHtml(metric.value)}</td><td>${escapeHtml(metric.interpretation)}</td></tr>`
                    )
                    .join("")}
                </table></div>`,
                false
              )}
            </div>`
          )
          .join("")}
      </div>`,
      true
    )}
  </section>

  <section class="card">
    <h2>4. What Was Tested</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.whatWasTested)}</p>
    ${renderAccordion(
      "Expand What Was Tested",
      `<div class="table-wrap"><table>
        <tr><th>URL</th><td>${escapeHtml(artifact.request.url)}</td></tr>
        <tr><th>Flow</th><td>${escapeHtml(artifact.request.flowDescription)}</td></tr>
        <tr><th>Environment</th><td>${escapeHtml(artifact.environment.emulation)}</td></tr>
        <tr><th>Limitations</th><td>${escapeHtml(artifact.request.limitations)}</td></tr>
      </table></div>`,
      false
    )}
  </section>

  <section class="card">
    <h2>5. Phase Results</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.phaseResults)}</p>
    ${renderAccordion(
      "Expand Phase Results",
      `<div class="table-wrap"><table>
        <tr><th>Phase</th><th>Status</th><th>Finding</th><th>Continued?</th></tr>
        ${artifact.phaseResults
          .map(
            (phase) => `<tr><td>${escapeHtml(phase.phase)}. ${escapeHtml(phase.name)}</td><td>${escapeHtml(phase.status)}</td><td>${escapeHtml(phase.finding)}</td><td>${phase.continued ? "Yes" : "No"}</td></tr>`
          )
          .join("")}
      </table></div>`,
      false
    )}
  </section>

  <section class="card">
    <h2>6. Key Metrics</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.keyMetrics)}</p>
    ${renderAccordion(
      "Expand Key Metrics",
      `<div class="metric-grid">
        <div class="metric"><div class="small">Console errors</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.consoleErrorCount)}</div></div>
        <div class="metric"><div class="small">Failed requests</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.failedRequestCount)}</div></div>
        <div class="metric"><div class="small">Long tasks</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.longTaskCount)}</div></div>
        <div class="metric"><div class="small">DOM nodes</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.domNodeCount)}</div></div>
        <div class="metric"><div class="small">DOM growth</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.domNodeGrowth)}</div></div>
        <div class="metric"><div class="small">Iframes</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.iframeCount)}</div></div>
        <div class="metric"><div class="small">Images</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.imageCount)}</div></div>
        <div class="metric"><div class="small">Eager images</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.eagerImagesBelowFold)}</div></div>
        <div class="metric"><div class="small">Eager iframes</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.eagerIframesBelowFold)}</div></div>
        <div class="metric"><div class="small">Ad warnings</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.adWarningCount)}</div></div>
        <div class="metric"><div class="small">Ad request issues</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.adRequestIssueCount)}</div></div>
        <div class="metric"><div class="small">Ad impact score</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.adImpactScore)}</div></div>
        <div class="metric"><div class="small">Peak scroll heap</div><div class="value">${formatBytes(artifact.keyMetrics.peakScrollHeapBytes)}</div></div>
        <div class="metric"><div class="small">Render churn</div><div class="value">${formatMaybeNumber(artifact.keyMetrics.rerenderMutationCount)}</div></div>
        <div class="metric"><div class="small">3P main-thread time</div><div class="value">${formatMaybeNumber(artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs)}</div></div>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Metric</th><th>Value</th><th>Interpretation</th></tr>
        ${artifact.metricRows
          .map(
            (row) => `<tr><td>${escapeHtml(row.metric)}</td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.interpretation)}</td></tr>`
          )
          .join("")}
      </table></div>`,
      false
    )}
  </section>

  <section class="card">
    <h2>7. Third-Party CPU Impact</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.thirdPartyCpuImpact)}</p>
    ${renderAccordion(
      "Expand Third-Party CPU Impact",
      artifact.thirdPartyCpuImpact.available
        ? `<div class="metric-grid">
            <div class="metric"><div class="small">Top vendor</div><div class="value">${escapeHtml(artifact.thirdPartyCpuImpact.topVendor ?? "n/a")}</div></div>
            <div class="metric"><div class="small">Attributed main-thread</div><div class="value">${formatMaybeNumber(artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs)} ms</div></div>
          </div>
          <div class="table-wrap"><table>
            <tr><th>Vendor</th><th>Main-Thread Time</th><th>Script Time</th><th>Long-Task Time</th><th>Long Tasks</th><th>Max Task</th><th>Confidence</th><th>Likely UX Effect</th></tr>
            ${artifact.thirdPartyCpuImpact.vendors
              .map(
                (vendor) => `<tr><td>${escapeHtml(vendor.vendor)}</td><td>${formatMaybeNumber(vendor.totalMainThreadTimeMs)} ms</td><td>${formatMaybeNumber(vendor.scriptExecutionTimeMs)} ms</td><td>${formatMaybeNumber(vendor.longTaskTimeMs)} ms</td><td>${formatMaybeNumber(vendor.longTaskCount)}</td><td>${formatMaybeNumber(vendor.maxTaskMs)} ms</td><td>${escapeHtml(vendor.confidence)}</td><td>${escapeHtml(vendor.likelyUxEffect)}</td></tr>`
              )
              .join("")}
          </table></div>
          <p class="small">${escapeHtml(artifact.thirdPartyCpuImpact.notes)}</p>`
        : `<p>${escapeHtml(artifact.thirdPartyCpuImpact.summary)}</p><p class="small">${escapeHtml(artifact.thirdPartyCpuImpact.notes)}</p>`,
      false
    )}
  </section>

  <section class="card">
    <h2>8. Memory and DOM Analysis</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.runtimeAnalysis)}</p>
    ${renderRuntimeAnalysisAtGlance(artifact)}
    ${renderAccordion(
      "Expand Memory and DOM Analysis",
      renderRuntimeAnalysisDetails(artifact),
      false
    )}
  </section>

  <section class="card">
    <h2>9. Evidence</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.evidence)}</p>
    ${renderAccordion(
      "Expand Evidence",
      `<h3>Screenshots</h3>
      ${artifact.evidence.screenshotsHtml}
      <h3>Top Console Messages</h3>
      <pre>${escapeHtml(artifact.evidence.consoleSummary)}</pre>
      <h3>Network Summary</h3>
      <pre>${escapeHtml(artifact.evidence.networkSummary)}</pre>
      <h3>Performance Trace Summary</h3>
      <pre>${escapeHtml(artifact.evidence.traceSummary)}</pre>`,
      false
    )}
  </section>

  <section class="card">
    <h2>10. Recommendations</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.recommendations)}</p>
    ${renderAccordion(
      "Expand Recommendations",
      `<h3>Decision-Mapped Actions</h3>
      <ul>
        ${artifact.decisionIssues.map((issue) => `<li><strong>${escapeHtml(issue.priority)} / ${escapeHtml(issue.ownership)}:</strong> ${escapeHtml(issue.recommendedAction)}</li>`).join("")}
      </ul>
      <h3>Recommended Actions</h3>
      <ol>
        ${artifact.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ol>`,
      true
    )}
  </section>

  <section class="card">
    <h2>11. Appendix</h2>
    <p class="section-summary">${escapeHtml(sectionSummaries.appendix)}</p>
    ${renderAccordion(
      "Expand Appendix",
      `<p>${escapeHtml(artifact.appendixNotes)}</p>
      ${aiScriptPlan.length > 0 ? `<h3>Engineering Action Plan</h3><ol>${aiScriptPlan.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : ""}
      <h3>MCP Prompt Used</h3>
      <pre>${escapeHtml(artifact.mcpPrompt)}</pre>`,
      false
    )}
  </section>
  </main>
</body>
</html>`;
}

function countConsoleErrors(audit: AuditArtifact): number {
  return audit.debugging.consoleMessageDetails.reduce((count, item) => {
    const text = item.text.toLowerCase();
    if (text.includes("level\":\"error") || text.includes("\"type\":\"error\"") || /\berror\b/.test(text)) {
      return count + 1;
    }
    return count;
  }, 0);
}

function countFailedRequests(audit: AuditArtifact): number {
  const text = audit.debugging.networkRequests?.text ?? "";
  const errorMatches = text.match(/net::ERR_[A-Z_]+/g) ?? [];
  const statusMatches = text.match(/\bstatusCode["':\s]+(?:4\d\d|5\d\d)\b/g) ?? [];
  return errorMatches.length + statusMatches.length;
}

function estimateLongTaskCount(audit: AuditArtifact): number | null {
  const text = [audit.trace.stopTrace.text, ...audit.trace.analyzedInsights.map((item) => item.text)].join("\n");
  const explicit = text.match(/long task/gi)?.length ?? 0;
  if (explicit > 0) {
    return explicit;
  }
  const durationMatches = [...text.matchAll(/Duration:\s*(\d+(?:\.\d+)?)\s*ms/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 50);
  return durationMatches.length > 0 ? durationMatches.length : null;
}

function extractDomNodeCount(audit: AuditArtifact): number | null {
  return extractEvaluationNumber(audit, "domNodes") ?? audit.scrollProfile?.maxDomNodes ?? null;
}

function extractEvaluationNumber(audit: AuditArtifact, key: string): number | null {
  const structured = extractToolResultRecord(audit.debugging.evaluation);
  const value = structured?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface RerenderSignal {
  available: boolean;
  mutationCount: number | null;
  changedNodeCount: number | null;
  longFrameCount: number | null;
}

function extractRerenderSignal(audit: AuditArtifact): RerenderSignal {
  const structured = extractToolResultRecord(audit.debugging.rerenderProbe);
  return {
    available: audit.debugging.rerenderProbe !== null && !(audit.debugging.rerenderProbe?.isError ?? true),
    mutationCount: getFiniteNumber(structured?.mutationCount),
    changedNodeCount: getFiniteNumber(structured?.changedNodeCount),
    longFrameCount: getFiniteNumber(structured?.longFrameCount)
  };
}

function buildDomAndRerenderFinding(
  audit: AuditArtifact,
  counts: {
    domNodeCount: number | null;
    rerenderSignal: RerenderSignal;
  }
): string {
  const parts: string[] = [];
  if (counts.domNodeCount !== null) {
    parts.push(`Live DOM count reached ${counts.domNodeCount}.`);
  }
  if (audit.scrollProfile !== null) {
    parts.push(`Scroll DOM growth was ${formatMaybeNumber(audit.scrollProfile.domNodeGrowth)}.`);
  }
  if (counts.rerenderSignal.available) {
    parts.push(
      `Short-window rerender probe observed ${formatMaybeNumber(counts.rerenderSignal.mutationCount)} DOM mutations across ${formatMaybeNumber(counts.rerenderSignal.changedNodeCount)} changed nodes.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : "DOM growth and rerender evidence were incomplete for this run.";
}

function buildDomSummary(audit: AuditArtifact, domNodeCount: number | null): string {
  const parts: string[] = [];
  if (domNodeCount !== null) {
    parts.push(`Live DOM count was ${formatMaybeNumber(domNodeCount)}.`);
  }
  if (audit.scrollProfile?.maxDomNodes !== null && audit.scrollProfile?.maxDomNodes !== undefined) {
    parts.push(`Maximum DOM seen during scroll was ${formatMaybeNumber(audit.scrollProfile.maxDomNodes)}.`);
  }
  if (audit.scrollProfile?.domNodeGrowth !== null && audit.scrollProfile?.domNodeGrowth !== undefined) {
    parts.push(`The page added ${formatMaybeNumber(audit.scrollProfile.domNodeGrowth)} DOM nodes across the sampled scroll flow.`);
  }
  if (parts.length === 0) {
    return "DOM size evidence was not available for this run.";
  }
  if ((audit.scrollProfile?.domNodeGrowth ?? 0) >= 150 || (domNodeCount ?? 0) >= 1500) {
    parts.push("That level of DOM size or growth can increase style recalculation, layout work, and memory cost as the session continues.");
  }
  return parts.join(" ");
}

function buildMemorySummary(audit: AuditArtifact): string {
  const heapStats = extractHeapStats(audit);
  const parts: string[] = [];
  if (audit.scrollProfile?.peakUsedJsHeapBytes !== null && audit.scrollProfile?.peakUsedJsHeapBytes !== undefined) {
    parts.push(`Peak live JS heap during scroll reached ${formatBytes(audit.scrollProfile.peakUsedJsHeapBytes)}.`);
  }
  if (heapStats.totalBytes !== null) {
    parts.push(`Heap snapshot total size was ${formatBytes(heapStats.totalBytes)}.`);
  }
  if (heapStats.nodeCount !== null) {
    parts.push(`Heap graph size was ${formatMaybeNumber(heapStats.nodeCount)} nodes.`);
  }
  if (parts.length === 0) {
    return "Memory snapshot or live heap evidence was not available for this run.";
  }
  if ((audit.scrollProfile?.peakUsedJsHeapBytes ?? 0) >= 180_000_000 || (heapStats.totalBytes ?? 0) >= 180_000_000) {
    parts.push("That amount of memory pressure can make long sessions less stable on constrained devices and increase the chance of tab eviction or renderer restarts.");
  }
  return parts.join(" ");
}

function buildScrollGrowthSummary(audit: AuditArtifact): string {
  const profile = audit.scrollProfile;
  if (!profile || profile.samples.length === 0) {
    return "Per-step scroll growth samples were not available.";
  }

  const first = profile.samples[0] ?? null;
  const last = profile.samples[profile.samples.length - 1] ?? null;
  const parts: string[] = [];
  if (first?.domNodes !== null && first?.domNodes !== undefined && last?.domNodes !== null && last?.domNodes !== undefined) {
    parts.push(`DOM nodes changed from ${formatMaybeNumber(first.domNodes)} to ${formatMaybeNumber(last.domNodes)} over ${profile.completedSteps} sampled steps.`);
  }
  if (first?.usedJsHeapBytes !== null && first?.usedJsHeapBytes !== undefined && last?.usedJsHeapBytes !== null && last?.usedJsHeapBytes !== undefined) {
    parts.push(`Measured JS heap changed from ${formatBytes(first.usedJsHeapBytes)} to ${formatBytes(last.usedJsHeapBytes)} during the same scroll flow.`);
  } else if (profile.peakUsedJsHeapBytes !== null && profile.peakUsedJsHeapBytes !== undefined) {
    parts.push(`Live heap sampling was partial, but peak JS heap reached ${formatBytes(profile.peakUsedJsHeapBytes)} during scroll.`);
  }
  if (profile.cumulativeLayoutShift !== null) {
    parts.push(`Scroll-time CLS reached ${formatMaybeFloat(profile.cumulativeLayoutShift)}.`);
  }
  return parts.length > 0 ? parts.join(" ") : "Scroll growth evidence was partial for this run.";
}

function buildLazyLoadingSummary(audit: AuditArtifact): string {
  const eagerImagesBelowFold = extractEvaluationNumber(audit, "eagerImagesBelowFold");
  const eagerIframesBelowFold = extractEvaluationNumber(audit, "eagerIframesBelowFold");
  const missingLazyImages = extractEvaluationNumber(audit, "missingLazyImages");
  const missingLazyIframes = extractEvaluationNumber(audit, "missingLazyIframes");

  const parts: string[] = [];
  if (eagerImagesBelowFold !== null) {
    parts.push(`${formatMaybeNumber(eagerImagesBelowFold)} below-the-fold images appeared eager.`);
  }
  if (eagerIframesBelowFold !== null) {
    parts.push(`${formatMaybeNumber(eagerIframesBelowFold)} below-the-fold iframes appeared eager.`);
  }
  if (missingLazyImages !== null) {
    parts.push(`${formatMaybeNumber(missingLazyImages)} images were missing an explicit loading hint.`);
  }
  if (missingLazyIframes !== null) {
    parts.push(`${formatMaybeNumber(missingLazyIframes)} iframes were missing an explicit loading hint.`);
  }

  if (parts.length === 0) {
    return "Lazy-loading evidence was not available for this run.";
  }
  if ((eagerImagesBelowFold ?? 0) >= 5 || (eagerIframesBelowFold ?? 0) >= 2) {
    parts.push("Those below-the-fold eager resources are strong candidates for lazy loading if they are not needed immediately.");
  } else if ((missingLazyImages ?? 0) > 0 || (missingLazyIframes ?? 0) > 0) {
    parts.push("Some media and embeds may benefit from more explicit lazy-loading hints, depending on product intent and viewport placement.");
  }

  return parts.join(" ");
}

function buildAdImpactSummary(audit: AuditArtifact): string {
  const signals = collectAdSignals(audit);
  const parts: string[] = [];

  if (signals.iframeCount !== null) {
    parts.push(`The page exposed ${formatMaybeNumber(signals.iframeCount)} iframe(s), which often reflects embed or ad-slot pressure on content pages.`);
  }
  if (signals.eagerIframesBelowFold !== null) {
    parts.push(`${formatMaybeNumber(signals.eagerIframesBelowFold)} below-the-fold iframe(s) appeared eager rather than deferred.`);
  }
  if (signals.adWarningCount > 0) {
    parts.push(`${formatMaybeNumber(signals.adWarningCount)} ad-related console warning(s) were captured.`);
  }
  if (signals.adRequestIssueCount > 0) {
    parts.push(`${formatMaybeNumber(signals.adRequestIssueCount)} ad-tech request issue(s) were visible in the captured network text.`);
  }
  if (hasInsight(audit, "ThirdParties")) {
    parts.push("Trace insights flagged third-party cost, which commonly translates into slower slot setup, extra main-thread work, and more unstable content loading.");
  }
  if (hasInsight(audit, "ForcedReflow")) {
    parts.push("Forced reflow was also present, which makes ad slot insertion and resize behavior more likely to affect reading smoothness.");
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    parts.push(`Scroll-time layout shift reached ${formatMaybeFloat(audit.scrollProfile?.cumulativeLayoutShift)}, which raises the chance that ads or embeds are moving content while users read.`);
  }

  if (parts.length === 0) {
    return "No clear ad-specific user-experience signal stood out in this run.";
  }

  if (computeAdImpactScore(audit) >= 5) {
    parts.push("Taken together, ads and third-party embeds are a meaningful candidate for degraded user experience in this run.");
  } else if (computeAdImpactScore(audit) >= 3) {
    parts.push("Ads and embeds appear to be contributing some user-experience cost, but they are not the only likely driver.");
  }

  return parts.join(" ");
}

function buildAdMetricsSummary(artifact: QuickCheckArtifact): string {
  const metrics = artifact.keyMetrics;
  const parts = [
    `Ad impact score: ${formatMaybeNumber(metrics.adImpactScore)} (${metrics.adImpactLevel ?? "n/a"}).`,
    `Ad-related console warnings: ${formatMaybeNumber(metrics.adWarningCount)}.`,
    `Ad-tech request issues: ${formatMaybeNumber(metrics.adRequestIssueCount)}.`,
    `Iframes: ${formatMaybeNumber(metrics.iframeCount)} total, with ${formatMaybeNumber(metrics.eagerIframesBelowFold)} eager below the fold.`,
    `Third-party insight present: ${metrics.thirdPartyInsightPresent ? "yes" : "no"}.`,
    `Forced reflow insight present: ${metrics.forcedReflowInsightPresent ? "yes" : "no"}.`
  ];
  return parts.join(" ");
}

function buildRuntimeScanSummary(artifact: QuickCheckArtifact): string {
  const metrics = artifact.keyMetrics;
  const profile = artifact.rawAudit.scrollProfile;
  const headlineSignals: string[] = [];

  if (metrics.forcedReflowInsightPresent) {
    headlineSignals.push("forced reflow");
  }
  if ((metrics.domNodeGrowth ?? 0) >= 150) {
    headlineSignals.push(`DOM growth of ${formatMaybeNumber(metrics.domNodeGrowth)} nodes`);
  }
  if ((profile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    headlineSignals.push(`scroll CLS ${formatMaybeFloat(profile?.cumulativeLayoutShift)}`);
  }
  if ((metrics.peakScrollHeapBytes ?? 0) >= 100_000_000) {
    headlineSignals.push(`${formatBytes(metrics.peakScrollHeapBytes)} peak heap`);
  }
  if ((artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs ?? 0) >= 250) {
    headlineSignals.push(`${formatMaybeNumber(artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs)} ms attributed third-party CPU`);
  }

  if (headlineSignals.length === 0) {
    return "Memory and DOM signals did not surface a dominant post-load risk in this run.";
  }

  return `Post-load experience is the main readout here: ${headlineSignals.slice(0, 4).join(", ")}.`;
}

function renderRuntimeAnalysisAtGlance(artifact: QuickCheckArtifact): string {
  const metrics = artifact.keyMetrics;
  const profile = artifact.rawAudit.scrollProfile;
  const topCpuVendor = artifact.thirdPartyCpuImpact.vendors[0] ?? null;

  return `<div class="scan-grid">
    ${renderSignalCard(
      "Post-load layout",
      metrics.forcedReflowInsightPresent ? "Forced reflow" : "No forced reflow",
      metrics.forcedReflowInsightPresent ? "critical" : "healthy",
      metrics.forcedReflowInsightPresent
        ? "Layout work is being triggered after scripts touch the page."
        : "The trace did not flag forced reflow as a headline issue."
    )}
    ${renderSignalCard(
      "DOM growth",
      formatMaybeNumber(metrics.domNodeGrowth),
      classifyDomGrowth(metrics.domNodeGrowth),
      `Max observed DOM: ${formatMaybeNumber(metrics.maxDomNodesObserved)} nodes.`
    )}
    ${renderSignalCard(
      "Scroll stability",
      formatMaybeFloat(profile?.cumulativeLayoutShift),
      classifyCls(profile?.cumulativeLayoutShift ?? null),
      "Higher CLS means content moved while the user was scrolling."
    )}
    ${renderSignalCard(
      "Peak JS heap",
      formatBytes(metrics.peakScrollHeapBytes),
      classifyHeapPressure(metrics.peakScrollHeapBytes),
      "A useful signal for memory pressure on mobile-class devices."
    )}
    ${renderSignalCard(
      "3P CPU leader",
      topCpuVendor ? topCpuVendor.vendor : "n/a",
      classifyThirdPartyCpu(topCpuVendor?.totalMainThreadTimeMs ?? null),
      topCpuVendor
        ? `${formatMaybeNumber(topCpuVendor.totalMainThreadTimeMs)} ms directly attributed main-thread time.`
        : "Trace attribution was not available for a top vendor."
    )}
    ${renderSignalCard(
      "Render churn",
      formatMaybeNumber(metrics.rerenderMutationCount),
      classifyRenderChurn(metrics.rerenderMutationCount),
      `Changed nodes: ${formatMaybeNumber(metrics.rerenderChangedNodeCount)}.`
    )}
  </div>`;
}

function renderRuntimeAnalysisDetails(artifact: QuickCheckArtifact): string {
  return `<div class="detail-grid">
    <div class="detail-panel">
      <h3>Responsiveness</h3>
      <p>${escapeHtml(buildRuntimeScanSummary(artifact))}</p>
      <p class="small">Forced reflow: ${artifact.keyMetrics.forcedReflowInsightPresent ? "yes" : "no"}. Third-party insight: ${artifact.keyMetrics.thirdPartyInsightPresent ? "yes" : "no"}.</p>
    </div>
    <div class="detail-panel">
      <h3>DOM Footprint</h3>
      <p>${escapeHtml(artifact.runtimeAnalysis.domSummary)}</p>
    </div>
    <div class="detail-panel">
      <h3>Memory Pressure</h3>
      <p>${escapeHtml(artifact.runtimeAnalysis.memorySummary)}</p>
    </div>
    <div class="detail-panel">
      <h3>Scroll Growth</h3>
      <p>${escapeHtml(artifact.runtimeAnalysis.scrollGrowthSummary)}</p>
    </div>
    <div class="detail-panel">
      <h3>Lazy Loading</h3>
      <p>${escapeHtml(artifact.runtimeAnalysis.lazyLoadingSummary)}</p>
    </div>
    <div class="detail-panel">
      <h3>Ads and Embeds</h3>
      <p>${escapeHtml(artifact.runtimeAnalysis.adImpactSummary)}</p>
      <p class="small">${escapeHtml(buildAdMetricsSummary(artifact))}</p>
    </div>
  </div>`;
}

function renderSignalCard(
  label: string,
  value: string,
  level: "critical" | "watch" | "healthy" | "info",
  summary: string
): string {
  return `<div class="signal-card ${level}">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value)}</div>
    <p class="summary">${escapeHtml(summary)}</p>
  </div>`;
}

function classifyDomGrowth(value: number | null): "critical" | "watch" | "healthy" | "info" {
  if (value === null) {
    return "info";
  }
  if (value >= 500) {
    return "critical";
  }
  if (value >= 150) {
    return "watch";
  }
  return "healthy";
}

function classifyCls(value: number | null): "critical" | "watch" | "healthy" | "info" {
  if (value === null) {
    return "info";
  }
  if (value >= 0.25) {
    return "critical";
  }
  if (value >= 0.1) {
    return "watch";
  }
  return "healthy";
}

function classifyHeapPressure(value: number | null): "critical" | "watch" | "healthy" | "info" {
  if (value === null) {
    return "info";
  }
  if (value >= 180_000_000) {
    return "critical";
  }
  if (value >= 100_000_000) {
    return "watch";
  }
  return "healthy";
}

function classifyThirdPartyCpu(value: number | null): "critical" | "watch" | "healthy" | "info" {
  if (value === null) {
    return "info";
  }
  if (value >= 1_000) {
    return "critical";
  }
  if (value >= 250) {
    return "watch";
  }
  return "healthy";
}

function classifyRenderChurn(value: number | null): "critical" | "watch" | "healthy" | "info" {
  if (value === null) {
    return "info";
  }
  if (value >= 400) {
    return "critical";
  }
  if (value >= 100) {
    return "watch";
  }
  return "healthy";
}

function decisionRank(issue: QuickCheckDecisionIssue): number {
  const severityScore =
    issue.severity === "Critical" ? 400 : issue.severity === "High" ? 300 : issue.severity === "Medium" ? 200 : 100;
  const priorityScore =
    issue.priority === "P0" ? 80 : issue.priority === "P1" ? 60 : issue.priority === "P2" ? 40 : 20;
  const leverageScore =
    issue.strategicLeverage === "Platform Multiplier"
      ? 30
      : issue.strategicLeverage === "Template Gain"
        ? 20
        : 10;
  return severityScore + priorityScore + leverageScore;
}

function buildSectionSummaries(artifact: QuickCheckArtifact): Record<string, string> {
  const aiSummary = artifact.rawAudit.aiOutput?.summary;
  return {
    decisionLayer: artifact.decisionSummary,
    userJourneyPerspective: artifact.commonViewpointSummary,
    whatWasTested:
      aiSummary?.environment ??
      `This run audited ${artifact.request.url} on ${artifact.request.deviceProfile} using ${artifact.environment.collector}.`,
    phaseResults: summarizePhaseResults(artifact),
    keyMetrics: summarizeKeyMetrics(artifact),
    thirdPartyCpuImpact: artifact.thirdPartyCpuImpact.summary,
    runtimeAnalysis: buildRuntimeScanSummary(artifact),
    evidence:
      artifact.rawAudit.aiOutput?.summary?.toolsUsed ??
      "The report includes captured console, network, trace, and runtime evidence gathered during the same run.",
    recommendations:
      aiSummary?.recommendedActions?.[0] ??
      artifact.recommendedAction,
    appendix:
      artifact.appendixNotes
  };
}

function summarizePhaseResults(artifact: QuickCheckArtifact): string {
  const passed = artifact.phaseResults.filter((phase) => phase.status === "Passed").length;
  const partial = artifact.phaseResults.filter((phase) => phase.status === "Partial").length;
  const failed = artifact.phaseResults.filter((phase) => phase.status === "Failed").length;
  return `${passed} phase(s) passed, ${partial} were partial, and ${failed} failed. This gives a quick view of how complete and trustworthy the run was.`;
}

function summarizeKeyMetrics(artifact: QuickCheckArtifact): string {
  const metrics = artifact.keyMetrics;
  const parts = [
    `${formatMaybeNumber(metrics.failedRequestCount)} failed request(s)`,
    `${formatMaybeNumber(metrics.domNodeCount)} live DOM nodes`,
    `${formatBytes(metrics.peakScrollHeapBytes)} peak scroll heap`,
    `${formatMaybeFloat(artifact.rawAudit.scrollProfile?.cumulativeLayoutShift)} scroll CLS`,
    `${formatMaybeNumber(artifact.thirdPartyCpuImpact.totalAttributedMainThreadTimeMs)} ms of directly attributed third-party main-thread time`
  ];
  return `The clearest headline metrics in this run were ${parts.join(", ")}.`;
}

function renderAccordion(summaryLabel: string, bodyHtml: string, open = false): string {
  return `<details${open ? " open" : ""}>
    <summary class="accordion-summary">${escapeHtml(summaryLabel)}</summary>
    <div class="accordion-body">${bodyHtml}</div>
  </details>`;
}

function formatRerenderSummary(signal: RerenderSignal): string {
  if (!signal.available) {
    return "n/a";
  }

  const fragments = [`${formatMaybeNumber(signal.mutationCount)} mutations`];
  if (signal.changedNodeCount !== null) {
    fragments.push(`${formatMaybeNumber(signal.changedNodeCount)} nodes`);
  }
  if (signal.longFrameCount !== null) {
    fragments.push(`${formatMaybeNumber(signal.longFrameCount)} long frames`);
  }
  return fragments.join(", ");
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getNestedRecord(
  value: Record<string, unknown> | null,
  path: Array<string | number>
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return null;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function getNestedString(
  value: Record<string, unknown> | null,
  path: Array<string | number>
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return null;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : null;
}

function extractLighthouseTiming(audit: AuditArtifact): number | null {
  const structured = extractRecord(audit.debugging.lighthouse?.structuredContent);
  const lighthouseResult = extractRecord(structured?.lighthouseResult);
  const summary = extractRecord(lighthouseResult?.summary);
  const timing = extractRecord(summary?.timing);
  return getFiniteNumber(timing?.total);
}

function extractHeapStats(audit: AuditArtifact): { totalBytes: number | null; nodeCount: number | null } {
  const structured = extractRecord(audit.memory?.summary?.structuredContent);
  const heapSnapshot = extractRecord(structured?.heapSnapshot);
  const stats = extractRecord(heapSnapshot?.stats);
  const staticData = extractRecord(heapSnapshot?.staticData);
  return {
    totalBytes: getFiniteNumber(stats?.total) ?? getFiniteNumber(staticData?.totalSize),
    nodeCount: getFiniteNumber(staticData?.nodeCount)
  };
}

function extractCompiledCodeBytes(audit: AuditArtifact): number | null {
  const structured = extractRecord(audit.memory?.summary?.structuredContent);
  const heapSnapshot = extractRecord(structured?.heapSnapshot);
  const stats = extractRecord(heapSnapshot?.stats);
  const v8heap = extractRecord(stats?.v8heap);
  return getFiniteNumber(v8heap?.code);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeVendorUrl(
  rawUrl: string,
  pageUrl: string
): { kind: "first_party" | "third_party"; vendor: string; domain: string } | null {
  try {
    const url = new URL(rawUrl);
    const page = new URL(pageUrl);
    const domain = url.hostname.replace(/^www\./, "");
    const pageDomain = page.hostname.replace(/^www\./, "");
    if (!domain) {
      return null;
    }

    const kind = domain === pageDomain || domain.endsWith(`.${pageDomain}`) ? "first_party" : "third_party";
    return {
      kind,
      domain,
      vendor: mapDomainToVendor(domain)
    };
  } catch {
    return null;
  }
}

function mapDomainToVendor(domain: string): string {
  const mappings: Array<[RegExp, string]> = [
    [/doubleclick|googlesyndication|googletagservices|googleads|adtrafficquality|imasdk/i, "Google Ads / GPT"],
    [/conde\.digital|condenastdigital|rum\.condenastdigital/i, "Conde Nast Platform"],
    [/cnevids/i, "CNE Video"],
    [/connatix|bidr\.io/i, "Connatix"],
    [/teads/i, "Teads"],
    [/amazon-adsystem|aps\.amazon/i, "Amazon Ads"],
    [/scorecardresearch/i, "Scorecard Research"],
    [/snowplow/i, "Snowplow"],
    [/parsely/i, "Parse.ly"],
    [/openx/i, "OpenX"],
    [/a47b\.com|aam\./i, "Audience Manager"],
    [/sc-static\.net/i, "Snap Pixel"],
    [/cloudflare/i, "Cloudflare CDN"]
  ];

  for (const [pattern, vendor] of mappings) {
    if (pattern.test(domain)) {
      return vendor;
    }
  }
  return domain;
}

function describeVendorCpuEffect(vendor: QuickCheckThirdPartyCpuVendor): string {
  if (vendor.longTaskCount > 0 || vendor.maxTaskMs >= 50) {
    return "Likely contributor to sticky scrolling or delayed interaction because it created long main-thread work.";
  }
  if (vendor.totalMainThreadTimeMs >= 100) {
    return "Meaningful CPU cost that can make the page feel heavier during load or scroll.";
  }
  return "Visible in the trace, but not the dominant CPU driver by itself.";
}

function classifyVendorOwnership(vendor: string): QuickCheckDecisionIssue["ownership"] {
  if (/google ads|connatix|teads|openx|amazon ads|audience manager/i.test(vendor)) {
    return "Ads/Monetization";
  }
  if (/conde nast platform|cloudflare/i.test(vendor)) {
    return "Frontend Platform";
  }
  return "Vendor/Partner";
}

function classifyAdImpactLevel(audit: AuditArtifact): string {
  const score = computeAdImpactScore(audit);
  if (score >= 5) {
    return "High";
  }
  if (score >= 3) {
    return "Moderate";
  }
  if (score >= 1) {
    return "Low";
  }
  return "Minimal";
}

function buildAdImpactInterpretation(audit: AuditArtifact): string {
  const level = classifyAdImpactLevel(audit);
  if (level === "High") {
    return "Ad-tech and embed behavior likely adds noticeable layout, network, or main-thread cost to the user experience.";
  }
  if (level === "Moderate") {
    return "Ads and embeds appear to contribute some visible experience cost, especially around load or scroll.";
  }
  if (level === "Low") {
    return "Ads are present, but they were not the strongest user-experience signal in this sample.";
  }
  return "No strong ad-specific impact signal was captured in this run.";
}

function computeAdImpactScore(audit: AuditArtifact): number {
  const signals = collectAdSignals(audit);
  let score = 0;

  if ((signals.iframeCount ?? 0) >= 10) {
    score += 1;
  }
  if ((signals.eagerIframesBelowFold ?? 0) >= 2) {
    score += 1;
  }
  if (signals.adWarningCount >= 2) {
    score += 1;
  }
  if (signals.adRequestIssueCount >= 2) {
    score += 1;
  }
  if (hasInsight(audit, "ThirdParties")) {
    score += 2;
  }
  if (hasInsight(audit, "ForcedReflow")) {
    score += 1;
  }
  if ((audit.scrollProfile?.cumulativeLayoutShift ?? 0) >= 0.1) {
    score += 1;
  }

  return score;
}

function collectAdSignals(audit: AuditArtifact): {
  iframeCount: number | null;
  eagerIframesBelowFold: number | null;
  adWarningCount: number;
  adRequestIssueCount: number;
} {
  return {
    iframeCount: extractEvaluationNumber(audit, "iframeCount"),
    eagerIframesBelowFold: extractEvaluationNumber(audit, "eagerIframesBelowFold"),
    adWarningCount: countAdConsoleWarnings(audit),
    adRequestIssueCount: countAdNetworkIssues(audit)
  };
}

function countAdConsoleWarnings(audit: AuditArtifact): number {
  const haystack = [
    audit.debugging.consoleMessages?.text ?? "",
    ...audit.debugging.consoleMessageDetails.map((item) => item.text)
  ].join("\n").toLowerCase();

  const adKeywords = [
    " pubads",
    "[gpt]",
    "doubleclick",
    "googletag",
    " ads.",
    "slot.",
    "connatix",
    "cnevids",
    "adsafe",
    "firsthand.ai"
  ];

  return adKeywords.reduce((count, keyword) => count + (haystack.includes(keyword) ? 1 : 0), 0);
}

function countAdNetworkIssues(audit: AuditArtifact): number {
  const text = (audit.debugging.networkRequests?.text ?? "").toLowerCase();
  const vendors = [
    "doubleclick",
    "googlesyndication",
    "pubads",
    "adtrafficquality",
    "connatix",
    "copper6",
    "pippio",
    "adsrvr",
    "adsafe",
    "amazon-adsystem",
    "cnevids",
    "responsiveads",
    "firsthand.ai"
  ];

  let count = 0;
  for (const vendor of vendors) {
    if (text.includes(vendor) && (text.includes("err_") || text.includes(" 400") || text.includes(" 404") || text.includes(" 451") || text.includes(" 5"))) {
      count += 1;
    }
  }
  return count;
}

function summarizeDomainsFromText(text: string): string[] {
  const matches = [...text.matchAll(/https?:\/\/([^\/\s]+)/g)].map((match) => match[1].replace(/^www\./, ""));
  const counts = new Map<string, number>();
  for (const domain of matches) {
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([domain, count]) => `${domain} (${count})`);
}

function hasInsight(audit: AuditArtifact, insightName: string): boolean {
  return audit.trace.analyzedInsights.some((item) => getInsightName(item.arguments) === insightName);
}

function getInsightName(argumentsRecord: Record<string, unknown>): string | null {
  const candidate = argumentsRecord.insightName;
  return typeof candidate === "string" ? candidate : null;
}

function createQuickCheckId(url: string): string {
  return `quick_check_${new Date().toISOString().replace(/[:.]/g, "-")}_${sanitizeFilenamePart(url).slice(0, 20)}`;
}

function cleanWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function extractRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractToolResultRecord(
  artifact: AuditArtifact["debugging"]["evaluation"] | AuditArtifact["debugging"]["rerenderProbe"]
): Record<string, unknown> | null {
  const direct = extractRecord(artifact?.structuredContent);
  if (direct) {
    const messagePayload = tryExtractJsonObject(typeof direct.message === "string" ? direct.message : null);
    return messagePayload ?? direct;
  }

  return tryExtractJsonObject(artifact?.text ?? null);
}

function tryExtractJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) {
    return null;
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1] ?? extractFirstBalancedJsonObject(text);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    return extractRecord(parsed);
  } catch {
    return null;
  }
}

function extractFirstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function formatMaybeNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function formatMaybeFloat(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  const mb = value / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
