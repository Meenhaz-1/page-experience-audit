export type AiMode = "disabled" | "structured_summary" | "markdown_report";

export type DetailLevel = "basic" | "full";

export type AuditStatus = "completed" | "completed_with_warnings" | "failed";

export type NavigationStatus =
  | "success"
  | "timeout"
  | "partial_load"
  | "redirected"
  | "terminal_error";

export type WarningCode =
  | "MCP_CONNECTION_FAILED"
  | "MCP_TOOL_FAILED"
  | "MCP_STRUCTURED_CONTENT_UNAVAILABLE"
  | "INSIGHT_ANALYSIS_SKIPPED"
  | "MEMORY_ANALYSIS_SKIPPED"
  | "AI_DISABLED"
  | "AI_FAILED"
  | "PERSISTENCE_FAILED";

export interface AuditWarning {
  code: WarningCode;
  message: string;
  recoverable: boolean;
}

export interface DeviceProfile {
  name: string;
  userAgent: string;
  viewport: {
    width: number;
    height: number;
    isMobile: boolean;
    hasTouch: boolean;
    deviceScaleFactor: number;
  };
}

export interface AuditRequest {
  url: string;
  timeoutMs?: number;
  settleTimeMs?: number;
  cpuThrottleRate?: number;
  deviceProfile?: string;
  lightMode?: boolean;
  aiMode?: AiMode;
  outputDetail?: DetailLevel;
  includeLighthouse?: boolean;
  includeMemory?: boolean;
  includeConsole?: boolean;
  includeEvaluation?: boolean;
  analyzeInsightsCount?: number;
  mcpCommand?: string;
  mcpArgs?: string[];
  browserUrl?: string;
  launchManagedBrowser?: boolean;
  logFile?: string;
  includeScrollProfile?: boolean;
  scrollSteps?: number;
  scrollPauseMs?: number;
}

export interface DevtoolsToolArtifact {
  toolName: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  text: string;
  structuredContent: unknown | null;
}

export interface InsightReference {
  insightSetId: string;
  insightName: string;
}

export interface NavigationSummary {
  requestedUrl: string;
  finalUrl: string | null;
  status: NavigationStatus;
  selectedPageId: number | null;
  startedAt: string;
  completedAt: string;
}

export interface TraceArtifacts {
  tracePath: string | null;
  startTrace: DevtoolsToolArtifact;
  stopTrace: DevtoolsToolArtifact;
  analyzedInsights: DevtoolsToolArtifact[];
  discoveredInsights: InsightReference[];
}

export interface MemoryArtifacts {
  heapSnapshotPath: string | null;
  takeHeapSnapshot: DevtoolsToolArtifact | null;
  summary: DevtoolsToolArtifact | null;
  details: DevtoolsToolArtifact | null;
  classNodes: DevtoolsToolArtifact[];
  retainers: DevtoolsToolArtifact[];
}

export interface DebuggingArtifacts {
  pageSnapshot: DevtoolsToolArtifact | null;
  networkRequests: DevtoolsToolArtifact | null;
  evaluation: DevtoolsToolArtifact | null;
  rerenderProbe: DevtoolsToolArtifact | null;
  consoleMessages: DevtoolsToolArtifact | null;
  consoleMessageDetails: DevtoolsToolArtifact[];
  lighthouse: DevtoolsToolArtifact | null;
}

export interface ScrollProfileSample {
  step: number;
  scrollY: number | null;
  scrollHeight: number | null;
  viewportHeight: number | null;
  domNodes: number | null;
  usedJsHeapBytes: number | null;
  timestamp: string;
}

export interface ScrollProfile {
  attempted: boolean;
  executionMethod: "evaluate_script" | "press_key" | "press_key_with_snapshot";
  completedSteps: number;
  traceCapturedDuringScroll: boolean;
  samples: ScrollProfileSample[];
  peakUsedJsHeapBytes: number | null;
  domNodeGrowth: number | null;
  maxDomNodes: number | null;
  cumulativeLayoutShift: number | null;
}

export interface DerivedSignals {
  insightCount: number;
  consoleMessageCount: number | null;
  memoryAnalysisIncluded: boolean;
  lighthouseIncluded: boolean;
  scrollProfileIncluded: boolean;
  liveDomElementCount: number | null;
  heapGraphNodeCount: number | null;
}

export interface AiSummary {
  headline: string;
  nonTechnicalTldr: string;
  investigationFindings: string;
  urlInvestigated: string;
  observedBehavior: string;
  environment: string;
  toolsUsed: string;
  summary: string;
  liveDomElementCount: number | null;
  heapGraphNodeCount: number | null;
  overallAssessment: string;
  primaryBottlenecks: string[];
  mainThreadLockups: string[];
  extremeMemoryAllocation: string[];
  domSizeAndReflows: string[];
  thirdPartyPayload: string[];
  recommendedActions: string[];
  scriptActionPlan: string[];
}

export interface AiOutput {
  provider: "openai";
  model: string;
  mode: Exclude<AiMode, "disabled">;
  summary: AiSummary | null;
  markdownReport: string | null;
  htmlReportPath: string | null;
  markdownReportPath: string | null;
}

export interface AuditArtifact {
  auditId: string;
  status: AuditStatus;
  request: Required<
    Pick<
      AuditRequest,
      | "url"
      | "timeoutMs"
      | "settleTimeMs"
      | "cpuThrottleRate"
      | "aiMode"
      | "outputDetail"
      | "lightMode"
      | "includeLighthouse"
      | "includeMemory"
      | "includeConsole"
      | "includeEvaluation"
      | "analyzeInsightsCount"
      | "launchManagedBrowser"
      | "includeScrollProfile"
      | "scrollSteps"
      | "scrollPauseMs"
    >
  > & {
    deviceProfile: string;
    mcpCommand: string;
    mcpArgs: string[];
    browserUrl: string | null;
    logFile: string | null;
  };
  environment: {
    collector: string;
    emulation: string;
  };
  navigation: NavigationSummary;
  trace: TraceArtifacts;
  memory: MemoryArtifacts | null;
  debugging: DebuggingArtifacts;
  scrollProfile: ScrollProfile | null;
  derivedSignals: DerivedSignals;
  warnings: AuditWarning[];
  aiOutput: AiOutput | null;
  createdAt: string;
}

export interface StoredArtifactRecord {
  artifact: AuditArtifact;
  artifactPath: string;
  markdownPath: string | null;
  htmlReportPath: string | null;
}
