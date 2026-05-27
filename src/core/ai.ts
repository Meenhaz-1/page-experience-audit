import OpenAI from "openai";

import { buildMarkdownPrompt, buildStructuredSummaryPrompt } from "./report-prompts.js";
import type { AiMode, AiOutput, AiSummary, AuditArtifact, AuditWarning } from "./types.js";

const STRUCTURED_SUMMARY_SCHEMA = {
  name: "performance_audit_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "headline",
      "nonTechnicalTldr",
      "investigationFindings",
      "urlInvestigated",
      "observedBehavior",
      "environment",
      "toolsUsed",
      "summary",
      "liveDomElementCount",
      "heapGraphNodeCount",
      "overallAssessment",
      "primaryBottlenecks",
      "mainThreadLockups",
      "extremeMemoryAllocation",
      "domSizeAndReflows",
      "thirdPartyPayload",
      "recommendedActions",
      "scriptActionPlan"
    ],
    properties: {
      headline: { type: "string" },
      nonTechnicalTldr: { type: "string" },
      investigationFindings: { type: "string" },
      urlInvestigated: { type: "string" },
      observedBehavior: { type: "string" },
      environment: { type: "string" },
      toolsUsed: { type: "string" },
      summary: { type: "string" },
      liveDomElementCount: {
        type: ["integer", "null"]
      },
      heapGraphNodeCount: {
        type: ["integer", "null"]
      },
      overallAssessment: { type: "string" },
      primaryBottlenecks: {
        type: "array",
        items: { type: "string" }
      },
      mainThreadLockups: {
        type: "array",
        items: { type: "string" }
      },
      extremeMemoryAllocation: {
        type: "array",
        items: { type: "string" }
      },
      domSizeAndReflows: {
        type: "array",
        items: { type: "string" }
      },
      thirdPartyPayload: {
        type: "array",
        items: { type: "string" }
      },
      recommendedActions: {
        type: "array",
        items: { type: "string" }
      },
      scriptActionPlan: {
        type: "array",
        items: { type: "string" }
      }
    }
  }
} as const;

export interface AiProvider {
  analyze(artifact: AuditArtifact, mode: Exclude<AiMode, "disabled">): Promise<AiOutput>;
}

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model = process.env.PAGE_AUDIT_MODEL ?? "gpt-4.1") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async analyze(artifact: AuditArtifact, mode: Exclude<AiMode, "disabled">): Promise<AiOutput> {
    if (mode === "structured_summary") {
      const response = await this.client.responses.create({
        model: this.model,
        instructions:
          "You are a senior frontend performance engineer. Produce concise, accurate, highly actionable analysis only from the provided artifact. Prioritize specific fixes over generic advice. Optimize for readability: short paragraphs, clear grouping, and scannable outputs instead of dense wall-of-text.",
        input: buildStructuredSummaryPrompt(artifact),
        text: {
          format: {
            type: "json_schema",
            ...STRUCTURED_SUMMARY_SCHEMA
          }
        }
      });

      const parsed = JSON.parse(response.output_text) as AiSummary;
      return {
        provider: "openai",
        model: this.model,
        mode,
        summary: parsed,
        markdownReport: null,
        htmlReportPath: null,
        markdownReportPath: null
      };
    }

    const response = await this.client.responses.create({
      model: this.model,
      instructions:
        "You are a senior frontend performance engineer. Produce an actionable markdown report grounded in the provided artifact only. Prefer concrete engineering changes tied to exact findings. Optimize for readability with short paragraphs and bullets where appropriate.",
      input: buildMarkdownPrompt(artifact)
    });

    return {
      provider: "openai",
      model: this.model,
      mode,
      summary: null,
      markdownReport: response.output_text,
      htmlReportPath: null,
      markdownReportPath: null
    };
  }
}

export function createAiDisabledWarning(): AuditWarning {
  return {
    code: "AI_DISABLED",
    message: "AI synthesis was disabled for this audit run.",
    recoverable: true
  };
}
