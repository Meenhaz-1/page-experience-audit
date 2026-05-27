import type { AuditArtifact, AuditRequest } from "../core/types.js";

export type QuickCheckOverallStatus = "Healthy" | "Watch" | "Needs Attention" | "Blocked";

export type QuickCheckPhaseStatus = "Passed" | "Partial" | "Failed";

export interface QuickCheckRequest extends AuditRequest {
  flowDescription?: string;
}

export interface QuickCheckPhaseResult {
  phase: string;
  name: string;
  status: QuickCheckPhaseStatus;
  finding: string;
  continued: boolean;
}

export interface QuickCheckMetricRow {
  metric: string;
  value: string;
  interpretation: string;
}

export type QuickCheckLensStatus = QuickCheckOverallStatus;

export interface QuickCheckLensMetric {
  label: string;
  value: string;
  interpretation: string;
}

export interface QuickCheckThirdPartyCpuVendor {
  vendor: string;
  domain: string;
  totalMainThreadTimeMs: number;
  scriptExecutionTimeMs: number;
  longTaskTimeMs: number;
  longTaskCount: number;
  maxTaskMs: number;
  taskCount: number;
  confidence: "Confirmed" | "Strongly Suspected" | "Directional" | "Low Confidence";
  timingWindow: string;
  likelyUxEffect: string;
}

export interface QuickCheckUserJourneyLens {
  name:
    | "Page Opens Reliably"
    | "Content Stays Stable"
    | "Scrolling Feels Smooth"
    | "Page Feels Responsive"
    | "Session Stays Stable";
  status: QuickCheckLensStatus;
  aiSummary: string;
  impactScore: number;
  primaryDrivers: string[];
  metrics: QuickCheckLensMetric[];
  whyItMatters: string;
}

export interface QuickCheckDecisionIssue {
  title: string;
  type:
    | "Reliability"
    | "Stability"
    | "Responsiveness"
    | "Memory"
    | "Ad/Third-Party Burden"
    | "Content Delivery";
  severity: "Critical" | "High" | "Medium" | "Low";
  priority: "P0" | "P1" | "P2" | "P3";
  timing: "Immediate" | "This Sprint" | "Planned" | "Monitor";
  businessImpact: string;
  userImpact: string;
  blastRadius: "Single URL" | "Template-Level" | "Site-Wide" | "Platform-Wide";
  confidence: "Confirmed" | "Strongly Suspected" | "Directional" | "Low Confidence";
  effort: "Small" | "Medium" | "Large";
  ownership:
    | "Page Team"
    | "Frontend Platform"
    | "Ads/Monetization"
    | "CDN/Network"
    | "Vendor/Partner";
  strategicLeverage: "One-Off Fix" | "Template Gain" | "Platform Multiplier";
  recommendedAction: string;
}

export interface QuickCheckArtifact {
  quickCheckId: string;
  createdAt: string;
  status: AuditArtifact["status"];
  overallStatus: QuickCheckOverallStatus;
  confidenceLevel: "High" | "Medium" | "Low";
  request: {
    url: string;
    flowDescription: string;
    limitations: string;
    deviceProfile: string;
    browserUrl: string | null;
    launchManagedBrowser: boolean;
  };
  environment: AuditArtifact["environment"];
  sourceAuditId: string;
  sourceAuditPath: string;
  plainEnglishSummary: string;
  commonViewpointSummary: string;
  decisionSummary: string;
  criticalAlerts: string[];
  topRisk: string;
  userImpact: string;
  recommendedAction: string;
  decisionIssues: QuickCheckDecisionIssue[];
  userJourneyImpact: QuickCheckUserJourneyLens[];
  thirdPartyCpuImpact: {
    available: boolean;
    summary: string;
    topVendor: string | null;
    totalAttributedMainThreadTimeMs: number | null;
    vendors: QuickCheckThirdPartyCpuVendor[];
    notes: string;
  };
  phaseResults: QuickCheckPhaseResult[];
  metricRows: QuickCheckMetricRow[];
  keyMetrics: {
    consoleErrorCount: number | null;
    failedRequestCount: number | null;
    longTaskCount: number | null;
    domNodeCount: number | null;
    domNodeGrowth: number | null;
    maxDomNodesObserved: number | null;
    iframeCount: number | null;
    imageCount: number | null;
    eagerImagesBelowFold: number | null;
    eagerIframesBelowFold: number | null;
    missingLazyImages: number | null;
    missingLazyIframes: number | null;
    adWarningCount: number | null;
    adRequestIssueCount: number | null;
    adImpactScore: number | null;
    adImpactLevel: string | null;
    thirdPartyInsightPresent: boolean;
    forcedReflowInsightPresent: boolean;
    peakScrollHeapBytes: number | null;
    rerenderMutationCount: number | null;
    rerenderChangedNodeCount: number | null;
    rerenderLongFrameCount: number | null;
  };
  runtimeAnalysis: {
    domSummary: string;
    memorySummary: string;
    scrollGrowthSummary: string;
    lazyLoadingSummary: string;
    adImpactSummary: string;
  };
  evidence: {
    screenshotsHtml: string;
    consoleSummary: string;
    networkSummary: string;
    traceSummary: string;
  };
  recommendations: string[];
  appendixNotes: string;
  mcpPrompt: string;
  rawAudit: AuditArtifact;
  htmlReportPath: string | null;
}
