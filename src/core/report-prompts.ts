import type { AuditArtifact } from "./types.js";

export function buildMarkdownPrompt(artifact: AuditArtifact): string {
  return [
    "Generate a technical markdown audit report for the following canonical audit artifact.",
    "This audit was orchestrated through chrome-devtools-mcp, using Chrome DevTools performance, memory, and debugging tools.",
    "Ground every claim in the recorded tool outputs and derived signals.",
    "Be specific and actionable. Prefer exact page behaviors, concrete third parties, specific console errors, and exact trace insights over generic performance advice.",
    "For each recommendation, explain what to change, why it matters on this page, and what metric or user-facing symptom it should improve.",
    "Important: heap snapshot nodeCount refers to heap graph nodes, not live DOM elements. Do not describe heap snapshot nodeCount as DOM node count unless the artifact separately provides a real DOM element count.",
    "Use derivedSignals.liveDomElementCount when reporting live DOM element count. Use derivedSignals.heapGraphNodeCount when reporting heap graph nodes.",
    "If pageSnapshot or networkRequests are present, treat them as meaningful partial coverage. Do not say that no page content or no instrumentation data was obtained if snapshot or network request evidence exists.",
    "If scroll profile data is present, explicitly call out memory spikes during scroll, DOM node growth during scroll, cumulative layout shift during the traced scroll period, whether trace was captured during scroll, and whether post-scroll memory or CLS/layout signals worsened.",
    "When the artifact supports it, include concrete actions around navigation load reliability, render-blocking or synchronous scripts, deprecated GPT ad API usage, preload misuse, Quirks Mode triggers, failed network resources, deferring non-critical ad scripts, and bundle-size or retention issues.",
    "If evidence is partial or ambiguous, say that explicitly instead of overclaiming.",
    "Start with a short non-technical TL;DR for product, editorial, or business stakeholders. It should explain in plain English whether the page feels healthy, what the biggest user-visible problems are, and what to fix first without jargon.",
    "Optimize for readability. Use short paragraphs for narrative sections and bullets for evidence-heavy or action-oriented sections. Avoid long wall-of-text paragraphs.",
    "Keep Investigation Findings and Summary concise: each should usually be 1-2 short paragraphs, not one giant dense block.",
    "When listing metrics or problem areas, group related items together and put the most important point first.",
    "Use this structure: Non-Technical TL;DR, Investigation Findings, URL Investigated, Observed Behavior, Environment, Tools Used, Summary, Detailed Findings, Recommended Action Plan.",
    "Include a separate section called Script Fix Action Plan focused on JavaScript bundles, ad scripts, third-party scripts, and deprecated script APIs.",
    "Within Detailed Findings, include these sections when supported by evidence: 1. Main Thread Lockups, 2. Extreme Memory Allocation, 3. DOM Size and Reflows, 4. Third-Party Payload.",
    JSON.stringify(artifact, null, 2)
  ].join("\n\n");
}

export function buildStructuredSummaryPrompt(artifact: AuditArtifact): string {
  return [
    "Summarize this canonical web performance audit artifact.",
    "Return a detailed investigation-style summary that matches this reporting style: Non-Technical TL;DR, Investigation Findings, URL Investigated, Observed Behavior, Environment, Tools Used, Summary, Detailed Findings, Recommended Action Plan.",
    "Populate nonTechnicalTldr with a plain-English 2-4 sentence summary for non-engineers. Avoid jargon where possible and focus on user impact, business risk, and the first priority fix.",
    "Recommendations must be concrete and page-specific, not generic. Mention exact insights, exact console/runtime failures, specific heavy third parties when present, and specific engineering actions.",
    "Important: heap snapshot nodeCount refers to heap graph nodes, not live DOM elements. Do not describe heap snapshot nodeCount as DOM node count unless the artifact separately provides a real DOM element count.",
    "Populate liveDomElementCount from derivedSignals.liveDomElementCount and heapGraphNodeCount from derivedSignals.heapGraphNodeCount. If unavailable, return null.",
    "If debugging.pageSnapshot or debugging.networkRequests are present, treat them as evidence of partial page coverage. Do not claim total instrumentation failure when those artifacts exist.",
    "If scroll profile data is present, explicitly mention peak used JS heap during scroll, DOM node growth during scroll, cumulative layout shift during the traced scroll period, whether trace was captured during scroll, and whether the page appears to accumulate DOM, layout shifts, or memory as content loads lazily.",
    "When supported by the artifact, make the action plan specific about navigation reliability, render-blocking scripts, deprecated GPT calls, preload misuse, Quirks Mode, failed network requests, deferred ad loading, bundle reduction, and a follow-up audit capturing INP, LCP, and DOM-size after fixes.",
    "Only recommend changes that are supported by the artifact. If data is incomplete, say so clearly.",
    "Optimize for readability. nonTechnicalTldr should be 2-4 short sentences. investigationFindings and summary should each be readable, compact prose rather than a giant paragraph.",
    "Use the arrays for scannable bullets. Put metrics, technical evidence, and concrete actions into the arrays instead of cramming them into investigationFindings or summary.",
    "Lead with the most important user-visible problem, then the strongest supporting evidence, then the first recommended fix.",
    "For Detailed Findings, populate four arrays: mainThreadLockups, extremeMemoryAllocation, domSizeAndReflows, thirdPartyPayload.",
    "Also populate scriptActionPlan with script-specific fixes separate from the broader recommendedActions list.",
    JSON.stringify(artifact, null, 2)
  ].join("\n\n");
}
