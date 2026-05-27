import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_AUDITS_DIR, withAuditDefaults } from "../core/defaults.js";
import type { AuditArtifact, AuditRequest, DevtoolsToolArtifact } from "../core/types.js";
import {
  auditArtifactPath,
  auditReportsDir,
  auditRunDir,
  roundMegabytes,
  sanitizeFilenamePart
} from "../core/utils.js";
import { createAuditEngine } from "../engine.js";
import type { MetricScore, UsabilityArtifact, UsabilityCategory, UsabilityRequest } from "./types.js";

export async function runUsabilityAudit(
  request: UsabilityRequest,
  progressSink?: (message: string, extra?: unknown) => void
): Promise<UsabilityArtifact> {
  const engine = createAuditEngine(progressSink);
  const audit = await engine.run({
    ...request,
    aiMode: "disabled"
  });

  const artifact = buildUsabilityArtifact(audit, request);
  const persisted = await persistUsabilityArtifact(artifact);
  artifact.htmlReportPath = persisted.htmlReportPath;
  return artifact;
}

export function buildUsabilityArtifact(
  audit: AuditArtifact,
  originalRequest: UsabilityRequest
): UsabilityArtifact {
  const normalized = withAuditDefaults({
    ...originalRequest,
    url: audit.request.url
  } as AuditRequest);

  const loadExperience = buildLoadExperience(audit);
  const scrollExperience = buildScrollExperience(audit);
  const interactionReadiness = buildInteractionReadiness(audit);
  const visualStability = buildVisualStability(audit);
  const reliability = buildReliability(audit);
  const memoryPressure = buildMemoryPressure(audit);
  const accessibility = buildAccessibility(audit);

  return {
    usabilityId: createUsabilityId(audit.request.url),
    status: audit.status,
    createdAt: new Date().toISOString(),
    request: {
      url: audit.request.url,
      timeoutMs: normalized.timeoutMs,
      settleTimeMs: normalized.settleTimeMs,
      cpuThrottleRate: normalized.cpuThrottleRate,
      lightMode: normalized.lightMode,
      includeLighthouse: normalized.includeLighthouse,
      includeMemory: normalized.includeMemory,
      includeConsole: normalized.includeConsole,
      includeEvaluation: normalized.includeEvaluation,
      includeScrollProfile: normalized.includeScrollProfile,
      scrollSteps: normalized.scrollSteps,
      scrollPauseMs: normalized.scrollPauseMs,
      deviceProfile: normalized.deviceProfile,
      browserUrl: normalized.browserUrl || null,
      launchManagedBrowser: normalized.launchManagedBrowser
    },
    environment: audit.environment,
    sourceAuditId: audit.auditId,
    sourceAuditPath: auditArtifactPath(DEFAULT_AUDITS_DIR, audit.auditId),
    loadExperience,
    scrollExperience,
    interactionReadiness,
    visualStability,
    reliability,
    memoryPressure,
    accessibility,
    topLevelHits: buildTopLevelHits(audit, {
      loadExperience,
      scrollExperience,
      interactionReadiness,
      visualStability,
      reliability,
      memoryPressure,
      accessibility
    }),
    recommendations: buildRecommendations({
      loadExperience,
      scrollExperience,
      interactionReadiness,
      visualStability,
      reliability,
      memoryPressure,
      accessibility
    }),
    rawAudit: audit,
    htmlReportPath: null
  };
}

async function persistUsabilityArtifact(artifact: UsabilityArtifact): Promise<{ htmlReportPath: string }> {
  const runDir = auditRunDir(DEFAULT_AUDITS_DIR, artifact.usabilityId);
  const artifactPath = auditArtifactPath(DEFAULT_AUDITS_DIR, artifact.usabilityId);
  const reportDir = auditReportsDir(DEFAULT_AUDITS_DIR, artifact.usabilityId);
  const htmlReportPath = path.join(reportDir, "summary.html");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  await fs.writeFile(htmlReportPath, renderUsabilityHtml(artifact), "utf8");
  return { htmlReportPath };
}

function buildLoadExperience(audit: AuditArtifact): UsabilityCategory {
  const lighthouse = extractLighthouseResult(audit);
  const accessibilityScore = extractLighthouseScore(lighthouse, "accessibility");
  const summary = getRecord(lighthouse, "summary");
  const timingRecord = getRecord(summary, "timing");
  const timing = getFiniteNumber(timingRecord?.total);
  const hasTrace = !audit.trace.startTrace.isError && !audit.trace.stopTrace.isError;
  const findings: string[] = [];

  if (hasTrace) {
    findings.push("Performance trace was captured successfully, so load-phase DevTools insights are available.");
  } else {
    findings.push("Trace capture was incomplete, which limits confidence in the load analysis.");
  }
  if (timing !== null) {
    findings.push(`Lighthouse snapshot timing completed in about ${timing.toFixed(0)} ms.`);
  }
  if (accessibilityScore !== null) {
    findings.push(`Lighthouse accessibility score during this run was ${(accessibilityScore * 100).toFixed(0)}.`);
  }

  const metrics: MetricScore[] = [
    metric("Trace Captured", hasTrace ? 1 : 0, null, hasTrace ? "Captured" : "Missing"),
    metric("Lighthouse Timing", timing, "ms", timing !== null ? interpretLowerIsBetter(timing, 5000, 15000) : "Not captured"),
    metric(
      "Lighthouse Accessibility Score",
      accessibilityScore !== null ? accessibilityScore * 100 : null,
      "score",
      accessibilityScore !== null ? interpretHigherIsBetter(accessibilityScore * 100, 90, 75) : "Not captured"
    )
  ];

  return categoryFromSignals(metrics, findings, "Load experience");
}

function buildScrollExperience(audit: AuditArtifact): UsabilityCategory {
  const scroll = audit.scrollProfile;
  const peakHeap = scroll?.peakUsedJsHeapBytes ?? null;
  const domGrowth = scroll?.domNodeGrowth ?? null;
  const cls = scroll?.cumulativeLayoutShift ?? null;
  const findings: string[] = [];

  if (scroll) {
    findings.push(`Scroll profile executed ${scroll.completedSteps} steps using ${scroll.executionMethod}.`);
    if (domGrowth !== null) {
      findings.push(`DOM nodes changed by ${domGrowth} across the scroll path.`);
    }
    if (cls !== null) {
      findings.push(`Scroll-time cumulative layout shift reached ${cls.toFixed(3)}.`);
    }
  } else {
    findings.push("No dedicated scroll profile was captured in this run.");
  }

  const metrics: MetricScore[] = [
    metric("Scroll Steps Completed", scroll?.completedSteps ?? null, "steps", scroll ? "Captured" : "Not captured"),
    metric(
      "Peak JS Heap During Scroll",
      peakHeap !== null ? roundMegabytes(peakHeap) : null,
      "MB",
      peakHeap !== null ? interpretLowerIsBetter(roundMegabytes(peakHeap), 150, 250) : "Not captured"
    ),
    metric(
      "DOM Growth During Scroll",
      domGrowth,
      "nodes",
      domGrowth !== null ? interpretLowerIsBetter(domGrowth, 100, 300) : "Not captured"
    ),
    metric(
      "Scroll CLS",
      cls,
      "cls",
      cls !== null ? interpretLowerIsBetter(cls, 0.1, 0.25) : "Not captured"
    )
  ];

  return categoryFromSignals(metrics, findings, "Scroll experience");
}

function buildInteractionReadiness(audit: AuditArtifact): UsabilityCategory {
  const hasEvaluation = audit.debugging.evaluation !== null && !audit.debugging.evaluation.isError;
  const consoleCount = audit.derivedSignals.consoleMessageCount;
  const findings: string[] = [
    hasEvaluation
      ? "Basic page evaluation succeeded, so the page was interactive enough for DOM/readiness checks."
      : "Page-scoped evaluation failed or was unavailable, which reduces confidence in generic interaction readiness."
  ];
  if (consoleCount !== null) {
    findings.push(`The run collected ${consoleCount} console messages during page use.`);
  }

  const metrics: MetricScore[] = [
    metric("Evaluation Available", hasEvaluation ? 1 : 0, null, hasEvaluation ? "Available" : "Unavailable"),
    metric("Console Message Count", consoleCount, "messages", consoleCount !== null ? interpretLowerIsBetter(consoleCount, 5, 20) : "Not captured")
  ];

  return categoryFromSignals(metrics, findings, "Interaction readiness");
}

function buildVisualStability(audit: AuditArtifact): UsabilityCategory {
  const scrollCls = audit.scrollProfile?.cumulativeLayoutShift ?? null;
  const liveDom = audit.derivedSignals.liveDomElementCount;
  const findings: string[] = [];

  if (scrollCls !== null) {
    findings.push(`Visual stability during scroll produced a CLS of ${scrollCls.toFixed(3)}.`);
  } else {
    findings.push("Scroll-time layout shift was not available in this run.");
  }
  if (liveDom !== null) {
    findings.push(`Live DOM element count at collection time was ${liveDom}.`);
  }

  const metrics: MetricScore[] = [
    metric("Scroll CLS", scrollCls, "cls", scrollCls !== null ? interpretLowerIsBetter(scrollCls, 0.1, 0.25) : "Not captured"),
    metric("Live DOM Elements", liveDom, "nodes", liveDom !== null ? interpretLowerIsBetter(liveDom, 800, 1500) : "Not captured")
  ];

  return categoryFromSignals(metrics, findings, "Visual stability");
}

function buildReliability(audit: AuditArtifact): UsabilityCategory {
  const warningCount = audit.warnings.length;
  const networkFailures = countPattern(audit.debugging.networkRequests?.text ?? "", /net::ERR_[A-Z_]+/g);
  const consoleErrors = countConsoleErrors(audit);
  const findings: string[] = [
    `The run finished with ${warningCount} audit warnings.`,
    `Detected ${networkFailures} explicit failed network request markers in the captured network text.`,
    `Detected ${consoleErrors} console/runtime error markers across console detail text.`
  ];

  const metrics: MetricScore[] = [
    metric("Audit Warning Count", warningCount, "warnings", interpretLowerIsBetter(warningCount, 3, 8)),
    metric("Network Failures", networkFailures, "requests", interpretLowerIsBetter(networkFailures, 1, 5)),
    metric("Console Errors", consoleErrors, "errors", interpretLowerIsBetter(consoleErrors, 1, 5))
  ];

  return categoryFromSignals(metrics, findings, "Reliability");
}

function buildMemoryPressure(audit: AuditArtifact): UsabilityCategory {
  const heapStats = extractHeapStats(audit);
  const peakHeap = audit.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const findings: string[] = [];

  if (peakHeap !== null) {
    findings.push(`Peak used JS heap during scroll reached ${roundMegabytes(peakHeap)} MB.`);
  }
  if (heapStats.totalBytes !== null) {
    findings.push(`Heap snapshot total size was ${roundMegabytes(heapStats.totalBytes)} MB.`);
  }
  if (heapStats.heapGraphNodes !== null) {
    findings.push(`Heap graph node count was ${heapStats.heapGraphNodes}.`);
  }
  if (heapStats.compiledCodeBytes !== null) {
    findings.push(`Compiled code accounted for ${roundMegabytes(heapStats.compiledCodeBytes)} MB of retained V8 heap.`);
  }

  const metrics: MetricScore[] = [
    metric("Peak Scroll Heap", peakHeap !== null ? roundMegabytes(peakHeap) : null, "MB", peakHeap !== null ? interpretLowerIsBetter(roundMegabytes(peakHeap), 150, 250) : "Not captured"),
    metric("Heap Snapshot Total", heapStats.totalBytes !== null ? roundMegabytes(heapStats.totalBytes) : null, "MB", heapStats.totalBytes !== null ? interpretLowerIsBetter(roundMegabytes(heapStats.totalBytes), 200, 300) : "Not captured"),
    metric("Heap Graph Nodes", heapStats.heapGraphNodes, "nodes", heapStats.heapGraphNodes !== null ? interpretLowerIsBetter(heapStats.heapGraphNodes, 2_500_000, 5_000_000) : "Not captured"),
    metric("Compiled Code Size", heapStats.compiledCodeBytes !== null ? roundMegabytes(heapStats.compiledCodeBytes) : null, "MB", heapStats.compiledCodeBytes !== null ? interpretLowerIsBetter(roundMegabytes(heapStats.compiledCodeBytes), 40, 80) : "Not captured")
  ];

  return categoryFromSignals(metrics, findings, "Memory pressure");
}

function buildAccessibility(audit: AuditArtifact): UsabilityCategory {
  const lighthouse = extractLighthouseResult(audit);
  const score = extractLighthouseScore(lighthouse, "accessibility");
  const summary = getRecord(lighthouse, "summary");
  const auditsRecord = getRecord(summary, "audits");
  const failedCount = getFiniteNumber(auditsRecord?.failed);
  const findings: string[] = [];

  if (score !== null) {
    findings.push(`Lighthouse accessibility score was ${(score * 100).toFixed(0)}.`);
  } else {
    findings.push("Accessibility score was not available in this run.");
  }
  if (failedCount !== null) {
    findings.push(`Lighthouse reported ${failedCount} failed audits in the snapshot run.`);
  }

  const metrics: MetricScore[] = [
    metric(
      "Accessibility Score",
      score !== null ? score * 100 : null,
      "score",
      score !== null ? interpretHigherIsBetter(score * 100, 90, 75) : "Not captured"
    ),
    metric("Failed Lighthouse Audits", failedCount, "audits", failedCount !== null ? interpretLowerIsBetter(failedCount, 3, 10) : "Not captured")
  ];

  return categoryFromSignals(metrics, findings, "Accessibility");
}

function buildTopLevelHits(
  audit: AuditArtifact,
  categories: Record<string, UsabilityCategory>
): UsabilityArtifact["topLevelHits"] {
  const scrollCls = audit.scrollProfile?.cumulativeLayoutShift ?? null;
  const peakHeap = audit.scrollProfile?.peakUsedJsHeapBytes ?? null;
  const heapStats = extractHeapStats(audit);

  return [
    {
      area: "Scroll Stability",
      value: scrollCls !== null ? scrollCls.toFixed(3) : "n/a",
      whyItMatters: "Captures how much the page visibly shifts while the user scrolls."
    },
    {
      area: "Scroll Memory Peak",
      value: peakHeap !== null ? `${roundMegabytes(peakHeap)} MB` : "n/a",
      whyItMatters: "Captures how much live JS heap the page consumes during user movement."
    },
    {
      area: "Retained Heap",
      value: heapStats.totalBytes !== null ? `${roundMegabytes(heapStats.totalBytes)} MB` : "n/a",
      whyItMatters: "Captures how much memory is still retained after the run reaches snapshot time."
    },
    {
      area: "Runtime Reliability",
      value: `${categories.reliability.metrics[0]?.value ?? "n/a"} warnings`,
      whyItMatters: "Captures whether the session stayed stable or produced significant tooling/runtime noise."
    }
  ];
}

function buildRecommendations(categories: Record<string, UsabilityCategory>): string[] {
  const recommendations: string[] = [];

  if (categories.scrollExperience.status === "poor") {
    recommendations.push("Investigate scroll-time DOM growth, layout shift, and lazy-load timing first, since those most directly affect how the page feels during reading or gallery use.");
  }
  if (categories.memoryPressure.status === "poor") {
    recommendations.push("Capture and compare heap snapshots to reduce retained memory, especially compiled code, strings, and other large retained classes.");
  }
  if (categories.reliability.status === "poor") {
    recommendations.push("Triage console/runtime failures and failed network requests, because those often map directly to broken or flaky user-facing behavior.");
  }
  if (categories.accessibility.status !== "good") {
    recommendations.push("Use the Lighthouse accessibility score as a starting point, then follow up with focused accessibility testing for navigation, focus order, and tap targets.");
  }
  if (recommendations.length === 0) {
    recommendations.push("This run looks broadly usable in the DevTools-backed signals captured here, so the next step is task-based interaction testing rather than more baseline telemetry.");
  }

  return recommendations;
}

function categoryFromSignals(metrics: MetricScore[], findings: string[], label: string): UsabilityCategory {
  const scores = metrics
    .map((metric) => scoreInterpretation(metric.interpretation))
    .filter((value): value is number => value !== null);

  const average = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  const status =
    average === null ? "unknown" : average >= 2.3 ? "good" : average >= 1.5 ? "mixed" : "poor";

  return {
    status,
    summary:
      status === "good"
        ? `${label} looks healthy in the captured DevTools-backed signals.`
        : status === "mixed"
          ? `${label} shows meaningful tradeoffs or mild risk in the captured DevTools-backed signals.`
          : status === "poor"
            ? `${label} shows clear user-facing usability risk in the captured DevTools-backed signals.`
            : `${label} could not be evaluated with confidence from the captured signals.`,
    metrics,
    findings
  };
}

function metric(label: string, value: number | null, unit: string | null, interpretation: string): MetricScore {
  return { label, value, unit, interpretation };
}

function interpretLowerIsBetter(value: number, goodMax: number, mixedMax: number): string {
  if (value <= goodMax) {
    return "Good";
  }
  if (value <= mixedMax) {
    return "Mixed";
  }
  return "Poor";
}

function interpretHigherIsBetter(value: number, goodMin: number, mixedMin: number): string {
  if (value >= goodMin) {
    return "Good";
  }
  if (value >= mixedMin) {
    return "Mixed";
  }
  return "Poor";
}

function scoreInterpretation(value: string): number | null {
  if (value === "Good" || value === "Captured" || value === "Available") {
    return 3;
  }
  if (value === "Mixed") {
    return 2;
  }
  if (value === "Poor" || value === "Missing" || value === "Unavailable") {
    return 1;
  }
  return null;
}

function extractLighthouseResult(audit: AuditArtifact): Record<string, unknown> | null {
  const structured = audit.debugging.lighthouse?.structuredContent;
  if (!structured || typeof structured !== "object") {
    return null;
  }

  const result = (structured as Record<string, unknown>).lighthouseResult;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

function extractLighthouseScore(
  lighthouseResult: Record<string, unknown> | null,
  scoreId: string
): number | null {
  const summary = getRecord(lighthouseResult, "summary");
  if (!summary) {
    return null;
  }
  const scores = summary.scores;
  if (!Array.isArray(scores)) {
    return null;
  }

  for (const item of scores) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.id === scoreId && typeof record.score === "number") {
      return record.score;
    }
  }

  return null;
}

function extractHeapStats(audit: AuditArtifact): {
  totalBytes: number | null;
  heapGraphNodes: number | null;
  compiledCodeBytes: number | null;
} {
  const structured = audit.memory?.summary?.structuredContent;
  if (structured && typeof structured === "object") {
    const heapSnapshot = (structured as Record<string, unknown>).heapSnapshot;
    if (heapSnapshot && typeof heapSnapshot === "object") {
      const stats = (heapSnapshot as Record<string, unknown>).stats;
      const staticData = (heapSnapshot as Record<string, unknown>).staticData;
      return {
        totalBytes:
          stats && typeof stats === "object" ? getFiniteNumber((stats as Record<string, unknown>).total) : null,
        heapGraphNodes:
          staticData && typeof staticData === "object"
            ? getFiniteNumber((staticData as Record<string, unknown>).nodeCount)
            : null,
        compiledCodeBytes:
          stats &&
          typeof stats === "object" &&
          (stats as Record<string, unknown>).v8heap &&
          typeof (stats as Record<string, unknown>).v8heap === "object"
            ? getFiniteNumber((((stats as Record<string, unknown>).v8heap as Record<string, unknown>).code))
            : null
      };
    }
  }

  return {
    totalBytes: null,
    heapGraphNodes: audit.derivedSignals.heapGraphNodeCount,
    compiledCodeBytes: null
  };
}

function countConsoleErrors(audit: AuditArtifact): number {
  return audit.debugging.consoleMessageDetails.reduce((count, item) => {
    return count + countPattern(item.text, /(uncaught|error|failed|exception)/gi);
  }, 0);
}

function countPattern(text: string, regex: RegExp): number {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getRecord(
  value: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const next = value?.[key];
  return next && typeof next === "object" ? (next as Record<string, unknown>) : null;
}

function createUsabilityId(url: string): string {
  return `usability_${new Date().toISOString().replace(/[:.]/g, "-")}_${sanitizeFilenamePart(url).slice(0, 20)}`;
}

function renderUsabilityHtml(artifact: UsabilityArtifact): string {
  const sections: Array<[string, UsabilityCategory]> = [
    ["Load Experience", artifact.loadExperience],
    ["Scroll Experience", artifact.scrollExperience],
    ["Interaction Readiness", artifact.interactionReadiness],
    ["Visual Stability", artifact.visualStability],
    ["Reliability", artifact.reliability],
    ["Memory Pressure", artifact.memoryPressure],
    ["Accessibility", artifact.accessibility]
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Usability Audit ${escapeHtml(artifact.usabilityId)}</title>
  <style>
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f7f4ed; color: #1f1d1a; }
    main { max-width: 1040px; margin: 0 auto; padding: 48px 24px 80px; }
    h1 { font-size: 2.4rem; line-height: 1.1; margin: 0 0 24px; }
    h2 { font-size: 1.35rem; margin: 32px 0 12px; border-top: 1px solid #d8cfbf; padding-top: 20px; }
    p, li, td, th { line-height: 1.7; font-size: 1rem; }
    .hero { background: linear-gradient(180deg, #fff9ef, #f6eee1); border: 1px solid #dfd2bd; border-radius: 18px; padding: 22px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card { background: #fffdf8; border: 1px solid #e4dccd; border-radius: 14px; padding: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid #e4dccd; text-align: left; padding: 10px 8px; vertical-align: top; }
    th { text-transform: uppercase; font-size: 0.84rem; letter-spacing: 0.04em; color: #6a6358; }
    ul { padding-left: 22px; }
    .status-good { color: #175c3a; }
    .status-mixed { color: #8b5d12; }
    .status-poor { color: #8b1d1d; }
    .status-unknown { color: #5b544b; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } main { padding: 28px 16px 56px; } }
  </style>
</head>
<body>
  <main>
    <h1>Usability Audit</h1>
    <div class="hero">
      <p><strong>URL:</strong> ${escapeHtml(artifact.request.url)}</p>
      <p><strong>Source Audit:</strong> ${escapeHtml(artifact.sourceAuditId)}</p>
      <p><strong>Environment:</strong> ${escapeHtml(artifact.environment.emulation)}</p>
    </div>
    <section>
      <h2>Top-Level Hits</h2>
      <table>
        <thead>
          <tr><th>Area</th><th>Value</th><th>Why It Matters</th></tr>
        </thead>
        <tbody>
          ${artifact.topLevelHits
            .map(
              (hit) => `<tr><td>${escapeHtml(hit.area)}</td><td>${escapeHtml(hit.value)}</td><td>${escapeHtml(hit.whyItMatters)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>
    <section class="grid">
      ${sections
        .map(
          ([title, category]) => `<div class="card">
            <h2>${escapeHtml(title)}</h2>
            <p class="status-${category.status}"><strong>Status:</strong> ${escapeHtml(category.status)}</p>
            <p>${escapeHtml(category.summary)}</p>
            <table>
              <thead><tr><th>Metric</th><th>Value</th><th>Interpretation</th></tr></thead>
              <tbody>
                ${category.metrics
                  .map(
                    (metric) => `<tr>
                      <td>${escapeHtml(metric.label)}</td>
                      <td>${escapeHtml(formatMetricValue(metric.value, metric.unit))}</td>
                      <td>${escapeHtml(metric.interpretation)}</td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
            <ul>${category.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>
          </div>`
        )
        .join("")}
    </section>
    <section>
      <h2>Recommendations</h2>
      <ul>${artifact.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMetricValue(value: number | null, unit: string | null): string {
  if (value === null) {
    return "n/a";
  }
  return unit ? `${new Intl.NumberFormat("en-US").format(Number(value.toFixed ? value.toFixed(3) : value))} ${unit}` : String(value);
}
