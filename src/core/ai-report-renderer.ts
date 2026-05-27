import type { AiOutput, AiSummary, AuditArtifact } from "./types.js";

export function renderAiReportHtml(artifact: AuditArtifact): string | null {
  const aiOutput = artifact.aiOutput;
  if (!aiOutput) {
    return null;
  }

  if (aiOutput.summary) {
    return renderStructuredSummaryHtml(artifact, aiOutput.summary);
  }

  if (aiOutput.markdownReport) {
    return renderMarkdownHtml(artifact, aiOutput.markdownReport);
  }

  return null;
}

function renderStructuredSummaryHtml(artifact: AuditArtifact, summary: AiSummary): string {
  return buildHtmlDocument(
    summary.headline,
    `
    <section class="hero">
      <h2>Non-Technical TL;DR</h2>
      ${renderNarrative(summary.nonTechnicalTldr)}
    </section>
    <section class="meta-grid">
      <div class="meta-card">
        <h2>Investigation Findings</h2>
        ${renderNarrative(summary.investigationFindings)}
      </div>
      <div class="meta-card">
        <h2>Run Context</h2>
        <p><strong>URL Investigated:</strong> ${escapeHtml(summary.urlInvestigated)}</p>
        <p><strong>Observed Behavior:</strong> ${escapeHtml(summary.observedBehavior)}</p>
        <p><strong>Environment:</strong> ${escapeHtml(summary.environment)}</p>
        <p><strong>Tools Used:</strong> ${escapeHtml(summary.toolsUsed)}</p>
      </div>
    </section>
    <section>
      <h2>Summary</h2>
      ${renderNarrative(summary.summary)}
    </section>
    <section class="metric-grid">
      <h2>Measured Counts</h2>
      <div class="metric-card">
        <div class="metric-label">Live DOM Elements</div>
        <div class="metric-value">${formatCount(summary.liveDomElementCount ?? extractLiveDomElementCount(artifact))}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Heap Graph Nodes</div>
        <div class="metric-value">${formatCount(summary.heapGraphNodeCount ?? extractHeapGraphNodeCount(artifact))}</div>
      </div>
    </section>
    <section>
      <h2>Detailed Findings</h2>
      ${renderFindingSection("1. Main Thread Lockups", summary.mainThreadLockups)}
      ${renderFindingSection("2. Extreme Memory Allocation", summary.extremeMemoryAllocation)}
      ${renderFindingSection("3. DOM Size and Reflows", summary.domSizeAndReflows)}
      ${renderFindingSection("4. Third-Party Payload", summary.thirdPartyPayload)}
    </section>
    <section>
      <h2>Script Fix Action Plan</h2>
      ${renderList(summary.scriptActionPlan)}
    </section>
    <section>
      <h2>Recommended Action Plan</h2>
      ${renderList(summary.recommendedActions)}
    </section>
    <section>
      <h2>Artifact Context</h2>
      <p><strong>Audit ID:</strong> ${escapeHtml(artifact.auditId)}</p>
      <p><strong>Status:</strong> ${escapeHtml(artifact.status)}</p>
      <p><strong>Created At:</strong> ${escapeHtml(artifact.createdAt)}</p>
    </section>
    ${renderScrollProfileSection(artifact)}
    `
  );
}

function renderMarkdownHtml(artifact: AuditArtifact, markdown: string): string {
  return buildHtmlDocument(
    `AI Report ${artifact.auditId}`,
    `<section><pre>${escapeHtml(markdown)}</pre></section>`
  );
}

function buildHtmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f7f4ed; color: #1f1d1a; }
    main { max-width: 920px; margin: 0 auto; padding: 48px 24px 80px; }
    h1 { font-size: 2.4rem; line-height: 1.1; margin: 0 0 24px; }
    h2 { font-size: 1.35rem; margin: 32px 0 12px; border-top: 1px solid #d8cfbf; padding-top: 20px; }
    h3 { font-size: 1.08rem; margin: 20px 0 10px; }
    p, li { font-size: 1.02rem; line-height: 1.7; }
    ul { padding-left: 22px; }
    section { margin-bottom: 18px; }
    .hero { background: linear-gradient(180deg, #fff9ef, #f6eee1); border: 1px solid #dfd2bd; border-radius: 18px; padding: 22px 22px 8px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .meta-card { background: #fffdf8; border: 1px solid #e4dccd; border-radius: 14px; padding: 18px; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .metric-card { background: #fffdf8; border: 1px solid #e4dccd; border-radius: 14px; padding: 18px; }
    .metric-label { color: #6a6358; font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric-value { font-size: 1.8rem; line-height: 1.1; margin-top: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #fffdf8; border: 1px solid #e4dccd; padding: 18px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.96rem; }
    th, td { border-bottom: 1px solid #e4dccd; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { font-size: 0.85rem; letter-spacing: 0.04em; text-transform: uppercase; color: #6a6358; }
    .lede { color: #5b544b; margin-bottom: 28px; }
    @media (max-width: 760px) {
      .meta-grid, .metric-grid { grid-template-columns: 1fr; }
      main { padding: 28px 16px 56px; }
      h1 { font-size: 2rem; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">AI-generated performance investigation report</p>
    ${body}
  </main>
</body>
</html>`;
}

function renderScrollProfileSection(artifact: AuditArtifact): string {
  const scrollProfile = artifact.scrollProfile;
  if (!scrollProfile) {
    return "";
  }

  const first = scrollProfile.samples[0];
  const last = scrollProfile.samples[scrollProfile.samples.length - 1];

  return `
    <section>
      <h2>Scroll Profile</h2>
      <p><strong>Execution Method:</strong> ${escapeHtml(scrollProfile.executionMethod)}</p>
      <p><strong>Completed Steps:</strong> ${formatCount(scrollProfile.completedSteps)}</p>
      <p><strong>Trace Captured During Scroll:</strong> ${scrollProfile.traceCapturedDuringScroll ? "yes" : "no"}</p>
      <p><strong>Samples:</strong> ${scrollProfile.samples.length}</p>
      <p><strong>Peak JS Heap During Scroll:</strong> ${formatBytes(scrollProfile.peakUsedJsHeapBytes)}</p>
      <p><strong>DOM Node Growth:</strong> ${formatCount(scrollProfile.domNodeGrowth)}</p>
      <p><strong>Max DOM Nodes Observed:</strong> ${formatCount(scrollProfile.maxDomNodes)}</p>
      <p><strong>Cumulative Layout Shift During Trace:</strong> ${formatFloat(scrollProfile.cumulativeLayoutShift)}</p>
      <p><strong>Scroll Range:</strong> ${formatPixelValue(first?.scrollY ?? null)} to ${formatPixelValue(last?.scrollY ?? null)}</p>
      ${scrollProfile.samples.length === 0 ? "<p>Per-step DOM and heap samples were not available for this scroll run, but the trace and later phases reflect post-scroll behavior.</p>" : ""}
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Scroll Y</th>
            <th>DOM Nodes</th>
            <th>Used JS Heap</th>
          </tr>
        </thead>
        <tbody>
          ${scrollProfile.samples
            .map(
              (sample) => `<tr>
            <td>${sample.step}</td>
            <td>${formatPixelValue(sample.scrollY)}</td>
            <td>${formatCount(sample.domNodes)}</td>
            <td>${formatBytes(sample.usedJsHeapBytes)}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </section>
  `;
}

function extractLiveDomElementCount(artifact: AuditArtifact): number | null {
  const evaluation = artifact.debugging.evaluation?.structuredContent;
  if (evaluation && typeof evaluation === "object") {
    const domNodes = (evaluation as Record<string, unknown>).domNodes;
    if (typeof domNodes === "number" && Number.isFinite(domNodes)) {
      return domNodes;
    }
  }

  return artifact.scrollProfile?.maxDomNodes ?? null;
}

function extractHeapGraphNodeCount(artifact: AuditArtifact): number | null {
  const structured = artifact.memory?.summary?.structuredContent;
  if (structured && typeof structured === "object") {
    const staticData = (structured as Record<string, unknown>).staticData;
    if (staticData && typeof staticData === "object") {
      const nodeCount = (staticData as Record<string, unknown>).nodeCount;
      if (typeof nodeCount === "number" && Number.isFinite(nodeCount)) {
        return nodeCount;
      }
    }
  }

  const text = artifact.memory?.summary?.text ?? "";
  const match = text.match(/"nodeCount":\s*(\d+)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
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

function formatBytes(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1024) {
    return `${value.toFixed(0)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatFloat(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toFixed(3);
}

function formatPixelValue(value: number | null): string {
  const formatted = formatCount(value);
  return formatted === "n/a" ? formatted : `${formatted}px`;
}
