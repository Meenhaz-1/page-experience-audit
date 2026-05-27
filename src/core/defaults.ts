import type { AuditRequest, DeviceProfile } from "./types.js";

export const DEFAULT_AUDITS_DIR = "audits";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_SETTLE_TIME_MS = 5_000;
export const DEFAULT_CPU_THROTTLE_RATE = 4;
export const DEFAULT_DEVICE_PROFILE = "iphone_16_pro";
export const DEFAULT_INSIGHT_COUNT = 3;
export const DEFAULT_SCROLL_STEPS = 8;
export const DEFAULT_SCROLL_PAUSE_MS = 750;
export const DEFAULT_MCP_COMMAND = "npx";
export const DEFAULT_MCP_SERVER_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--headless=true",
  "--isolated=true",
  "--experimentalPageIdRouting=true",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--experimentalMemory=true",
  "--experimentalStructuredContent=true"
];

export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  desktop_1440: {
    name: "Desktop 1440",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: {
      width: 1440,
      height: 900,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1
    }
  },
  iphone_16_pro: {
    name: "iPhone 16 Pro",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    viewport: {
      width: 393,
      height: 852,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    }
  }
};

export function withAuditDefaults(request: AuditRequest): Required<AuditRequest> {
  const lightMode = request.lightMode ?? process.env.PAGE_AUDIT_LIGHT_MODE === "true";
  const defaultDeviceProfile = lightMode ? "desktop_1440" : DEFAULT_DEVICE_PROFILE;
  const defaultCpuThrottleRate = lightMode ? 1 : DEFAULT_CPU_THROTTLE_RATE;

  return {
    url: request.url,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    settleTimeMs: request.settleTimeMs ?? DEFAULT_SETTLE_TIME_MS,
    cpuThrottleRate: request.cpuThrottleRate ?? defaultCpuThrottleRate,
    deviceProfile: request.deviceProfile ?? defaultDeviceProfile,
    lightMode,
    aiMode: request.aiMode ?? "disabled",
    outputDetail: request.outputDetail ?? "full",
    includeLighthouse: request.includeLighthouse ?? true,
    includeMemory: request.includeMemory ?? true,
    includeConsole: request.includeConsole ?? true,
    includeEvaluation: request.includeEvaluation ?? true,
    analyzeInsightsCount: request.analyzeInsightsCount ?? DEFAULT_INSIGHT_COUNT,
    launchManagedBrowser:
      request.launchManagedBrowser ?? process.env.PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER === "true",
    includeScrollProfile: request.includeScrollProfile ?? true,
    scrollSteps: request.scrollSteps ?? DEFAULT_SCROLL_STEPS,
    scrollPauseMs: request.scrollPauseMs ?? DEFAULT_SCROLL_PAUSE_MS,
    mcpCommand: request.mcpCommand ?? DEFAULT_MCP_COMMAND,
    mcpArgs: request.mcpArgs ?? DEFAULT_MCP_SERVER_ARGS,
    browserUrl:
      request.launchManagedBrowser ?? process.env.PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER === "true"
        ? ""
        : request.browserUrl ?? process.env.PAGE_AUDIT_MCP_BROWSER_URL ?? "",
    logFile: request.logFile ?? process.env.PAGE_AUDIT_MCP_LOG_FILE ?? ""
  };
}
