import { z } from "zod";

export const runAuditInputSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(300000).optional(),
  settleTimeMs: z.number().int().nonnegative().max(60000).optional(),
  cpuThrottleRate: z.number().positive().max(20).optional(),
  deviceProfile: z.string().optional(),
  lightMode: z.boolean().optional(),
  aiMode: z.enum(["disabled", "structured_summary", "markdown_report"]).optional(),
  outputDetail: z.enum(["basic", "full"]).optional(),
  includeLighthouse: z.boolean().optional(),
  includeMemory: z.boolean().optional(),
  includeConsole: z.boolean().optional(),
  includeEvaluation: z.boolean().optional(),
  includeScrollProfile: z.boolean().optional(),
  analyzeInsightsCount: z.number().int().positive().max(10).optional(),
  launchManagedBrowser: z.boolean().optional(),
  scrollSteps: z.number().int().positive().max(50).optional(),
  scrollPauseMs: z.number().int().positive().max(10000).optional(),
  mcpCommand: z.string().optional(),
  mcpArgs: z.array(z.string()).optional(),
  browserUrl: z.string().url().optional(),
  logFile: z.string().optional()
});

export const getAuditInputSchema = z.object({
  auditId: z.string().min(1)
});

export type RunAuditInput = z.infer<typeof runAuditInputSchema>;
export type GetAuditInput = z.infer<typeof getAuditInputSchema>;
