import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { DEVICE_PROFILES } from "./defaults.js";
import type {
  DevtoolsToolArtifact,
  DeviceProfile,
  InsightReference,
  NavigationStatus
} from "./types.js";
import { auditHeapSnapshotPath, auditTracePath } from "./utils.js";

interface ChromeDevtoolsMcpClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  onLog?: (message: string, extra?: unknown) => Promise<void> | void;
}

export interface BrowserEndpointProbeResult {
  ok: boolean;
  endpoint: string;
  status: number | null;
  error: string | null;
}

export class ChromeDevtoolsMcpClient {
  private readonly client = new Client({
    name: "page-audit",
    version: "0.1.0"
  });

  private readonly transport: StdioClientTransport;

  constructor(private readonly options: ChromeDevtoolsMcpClientOptions) {
    this.transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      cwd: options.cwd
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000
  ): Promise<DevtoolsToolArtifact> {
    const startedAt = Date.now();
    await this.options.onLog?.("tool:start", { toolName, args, timeoutMs });
    const result = (await Promise.race([
      this.client.callTool({
        name: toolName,
        arguments: args
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${toolName} timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ])) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    const text = (result.content ?? [])
      .filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");

    return {
      ...(await this.finishLog(toolName, args, startedAt, result)),
      toolName,
      arguments: args,
      isError: Boolean(result.isError),
      text,
      structuredContent: "structuredContent" in result ? result.structuredContent : null
    };
  }

  private async finishLog(
    toolName: string,
    args: Record<string, unknown>,
    startedAt: number,
    result: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
  ): Promise<Record<string, never>> {
    await this.options.onLog?.("tool:end", {
      toolName,
      args,
      durationMs: Date.now() - startedAt,
      isError: Boolean(result.isError),
      hasStructuredContent: result.structuredContent != null
    });
    return {};
  }
}

export function buildEmulationArgs(profile: DeviceProfile, cpuThrottleRate: number) {
  return {
    cpuThrottlingRate: cpuThrottleRate,
    userAgent: profile.userAgent,
    viewport: `${profile.viewport.width}x${profile.viewport.height}x${profile.viewport.deviceScaleFactor},mobile,touch`
  };
}

export function traceFilePath(auditId: string): string {
  return auditTracePath("audits", auditId);
}

export function heapSnapshotPath(auditId: string): string {
  return auditHeapSnapshotPath("audits", auditId);
}

export function extractPageId(artifact: DevtoolsToolArtifact): number | null {
  return extractPageIds(artifact)[0] ?? null;
}

export function extractPageIndexes(artifact: DevtoolsToolArtifact): number[] {
  const indexes = new Set<number>();

  collectPageIndexesFromUnknown(artifact.structuredContent, indexes);

  for (const match of artifact.text.matchAll(/pageIdx["'\s:=]+(\d+)/gi)) {
    indexes.add(Number(match[1]));
  }

  for (const match of artifact.text.matchAll(/\[(\d+)\]\s+/g)) {
    indexes.add(Number(match[1]));
  }

  return [...indexes].sort((left, right) => left - right);
}

export function extractFinalUrl(artifact: DevtoolsToolArtifact): string | null {
  const structured = artifact.structuredContent as Record<string, unknown> | null;
  const candidate =
    (structured?.url as string | undefined) ??
    (structured?.finalUrl as string | undefined) ??
    extractStringByRegex(artifact.text, /(https?:\/\/[^\s'"]+)/i);

  return candidate ?? null;
}

export function extractPageIds(artifact: DevtoolsToolArtifact): number[] {
  const ids = new Set<number>();

  collectPageIdsFromUnknown(artifact.structuredContent, ids);

  for (const match of artifact.text.matchAll(/pageId["'\s:=]+(\d+)/gi)) {
    ids.add(Number(match[1]));
  }

  return [...ids];
}

export function deriveNavigationStatus(
  newPageArtifact: DevtoolsToolArtifact,
  finalUrl: string | null
): NavigationStatus {
  if (newPageArtifact.isError) {
    return "terminal_error";
  }

  return finalUrl ? "success" : "partial_load";
}

export function extractInsightReferences(artifact: DevtoolsToolArtifact): InsightReference[] {
  const found = new Map<string, InsightReference>();
  const structured = artifact.structuredContent as Record<string, unknown> | null;
  const insightSetIds = extractInsightSetIds(artifact);

  const traceInsights = structured?.traceInsights;
  if (Array.isArray(traceInsights)) {
    for (const item of traceInsights) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const insightName =
        typeof record.insightName === "string"
          ? record.insightName
          : typeof record.insightKey === "string"
            ? record.insightKey
            : null;

      if (!insightName) {
        continue;
      }

      const candidateSetId =
        typeof record.insightSetId === "string" ? record.insightSetId : insightSetIds[0] ?? "NO_NAVIGATION";
      found.set(`${candidateSetId}:${insightName}`, {
        insightSetId: candidateSetId,
        insightName
      });
    }
  }

  const pairRegexes = [
    /insightSetId["'\s:=]+([A-Za-z0-9._:-]+)[\s\S]{0,200}?insightName["'\s:=]+([A-Za-z0-9._:-]+)/gi,
    /insightName["'\s:=]+([A-Za-z0-9._:-]+)[\s\S]{0,200}?insightSetId["'\s:=]+([A-Za-z0-9._:-]+)/gi
  ];

  for (const regex of pairRegexes) {
    for (const match of artifact.text.matchAll(regex)) {
      const [first, second] = [match[1], match[2]];
      const insightSetId = regex === pairRegexes[0] ? first : second;
      const insightName = regex === pairRegexes[0] ? second : first;
      found.set(`${insightSetId}:${insightName}`, { insightSetId, insightName });
    }
  }

  return [...found.values()];
}

export function extractConsoleMessageIds(artifact: DevtoolsToolArtifact, limit: number): number[] {
  const ids = new Set<number>();
  for (const match of artifact.text.matchAll(/msgid["'\s:=]+(\d+)/gi)) {
    ids.add(Number(match[1]));
    if (ids.size >= limit) {
      break;
    }
  }
  return [...ids];
}

export function extractHeapClassIds(artifact: DevtoolsToolArtifact, limit: number): number[] {
  const ids = new Set<number>();
  for (const match of artifact.text.matchAll(/\bid["'\s:=]+(\d+)/gi)) {
    ids.add(Number(match[1]));
    if (ids.size >= limit) {
      break;
    }
  }
  return [...ids];
}

export function extractHeapNodeIds(artifact: DevtoolsToolArtifact, limit: number): number[] {
  const ids = new Set<number>();
  for (const match of artifact.text.matchAll(/nodeId["'\s:=]+(\d+)/gi)) {
    ids.add(Number(match[1]));
    if (ids.size >= limit) {
      break;
    }
  }
  return [...ids];
}

export function getDeviceProfile(name: string): DeviceProfile {
  const profile = DEVICE_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown device profile: ${name}`);
  }
  return profile;
}

export function browserVersionEndpoint(browserUrl: string): string {
  return new URL("/json/version", browserUrl).toString();
}

export function isBrowserConnectionFailureText(value: string): boolean {
  return (
    value.includes("Could not connect to Chrome") ||
    value.includes("Failed to fetch browser webSocket URL") ||
    value.includes("fetch failed")
  );
}

export async function probeBrowserEndpoint(
  browserUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserEndpointProbeResult> {
  const endpoint = browserVersionEndpoint(browserUrl);

  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        status: response.status,
        error: `HTTP ${response.status}`
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const webSocketDebuggerUrl = payload.webSocketDebuggerUrl;

    return {
      ok: typeof webSocketDebuggerUrl === "string" && webSocketDebuggerUrl.length > 0,
      endpoint,
      status: response.status,
      error:
        typeof webSocketDebuggerUrl === "string" && webSocketDebuggerUrl.length > 0
          ? null
          : "Missing webSocketDebuggerUrl in /json/version response"
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      status: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function extractNumberByRegex(value: string, regex: RegExp): number | null {
  const match = regex.exec(value);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractStringByRegex(value: string, regex: RegExp): string | null {
  const match = regex.exec(value);
  return match?.[1] ?? null;
}

function collectPageIdsFromUnknown(value: unknown, ids: Set<number>): void {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPageIdsFromUnknown(item, ids);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "pageId" && typeof child === "number" && Number.isFinite(child)) {
      ids.add(child);
    } else {
      collectPageIdsFromUnknown(child, ids);
    }
  }
}

function collectPageIndexesFromUnknown(value: unknown, indexes: Set<number>): void {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPageIndexesFromUnknown(item, indexes);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if ((key === "pageIdx" || key === "index") && typeof child === "number" && Number.isFinite(child)) {
      indexes.add(child);
    } else {
      collectPageIndexesFromUnknown(child, indexes);
    }
  }
}

function extractInsightSetIds(artifact: DevtoolsToolArtifact): string[] {
  const ids = new Set<string>();

  const structured = artifact.structuredContent as Record<string, unknown> | null;
  const summary =
    typeof structured?.traceSummary === "string" ? structured.traceSummary : artifact.text;

  for (const match of summary.matchAll(/insight set id:\s*([A-Za-z0-9._:-]+)/gi)) {
    ids.add(match[1]);
  }

  return [...ids];
}
