import type { AuditArtifact, AuditRequest, AuditStatus } from "../core/types.js";

export interface UsabilityRequest extends AuditRequest {}

export interface MetricScore {
  label: string;
  value: number | null;
  unit: string | null;
  interpretation: string;
}

export interface UsabilityCategory {
  status: "good" | "mixed" | "poor" | "unknown";
  summary: string;
  metrics: MetricScore[];
  findings: string[];
}

export interface UsabilityArtifact {
  usabilityId: string;
  status: AuditStatus;
  createdAt: string;
  request: Required<
    Pick<
      AuditRequest,
      | "url"
      | "timeoutMs"
      | "settleTimeMs"
      | "cpuThrottleRate"
      | "lightMode"
      | "includeLighthouse"
      | "includeMemory"
      | "includeConsole"
      | "includeEvaluation"
      | "includeScrollProfile"
      | "scrollSteps"
      | "scrollPauseMs"
    >
  > & {
    deviceProfile: string;
    browserUrl: string | null;
    launchManagedBrowser: boolean;
  };
  environment: AuditArtifact["environment"];
  sourceAuditId: string;
  sourceAuditPath: string | null;
  loadExperience: UsabilityCategory;
  scrollExperience: UsabilityCategory;
  interactionReadiness: UsabilityCategory;
  visualStability: UsabilityCategory;
  reliability: UsabilityCategory;
  memoryPressure: UsabilityCategory;
  accessibility: UsabilityCategory;
  topLevelHits: Array<{
    area: string;
    value: string;
    whyItMatters: string;
  }>;
  recommendations: string[];
  rawAudit: AuditArtifact;
  htmlReportPath: string | null;
}
