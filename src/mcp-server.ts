import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import "./env.js";
import { createAuditEngine } from "./engine.js";

const engine = createAuditEngine();

const server = new McpServer({
  name: "page-audit",
  version: "0.1.0"
});

function toStructuredContent(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

server.registerTool(
  "run_web_performance_audit",
  {
    title: "Run Web Performance Audit",
    description:
      "Runs a Chrome DevTools MCP-backed audit and returns a canonical audit artifact.",
    inputSchema: {
      url: z.string().url(),
      timeoutMs: z.number().int().positive().max(300000).optional(),
      settleTimeMs: z.number().int().nonnegative().max(60000).optional(),
      cpuThrottleRate: z.number().positive().max(20).optional(),
      deviceProfile: z.string().optional(),
      aiMode: z.enum(["disabled", "structured_summary", "markdown_report"]).optional(),
      outputDetail: z.enum(["basic", "full"]).optional(),
      includeLighthouse: z.boolean().optional(),
      includeMemory: z.boolean().optional(),
      includeConsole: z.boolean().optional(),
      includeEvaluation: z.boolean().optional(),
      analyzeInsightsCount: z.number().int().positive().max(10).optional(),
      mcpCommand: z.string().optional(),
      mcpArgs: z.array(z.string()).optional()
    }
  },
  async (args) => {
    const artifact = await engine.run(args);
    return {
      structuredContent: toStructuredContent(artifact),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              auditId: artifact.auditId,
              status: artifact.status,
              warningCount: artifact.warnings.length
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.registerTool(
  "get_web_performance_audit",
  {
    title: "Get Web Performance Audit",
    description: "Fetches a previously persisted audit artifact by audit ID.",
    inputSchema: {
      auditId: z.string().min(1)
    }
  },
  async ({ auditId }) => {
    const artifact = await engine.get(auditId);

    if (!artifact) {
      return {
        structuredContent: {
          auditId,
          found: false
        },
        content: [{ type: "text", text: `Audit ${auditId} was not found.` }],
        isError: true
      };
    }

    return {
      structuredContent: toStructuredContent(artifact),
      content: [{ type: "text", text: JSON.stringify(artifact, null, 2) }]
    };
  }
);

server.registerResource(
  "audit_result",
  new ResourceTemplate("audit://{auditId}", { list: undefined }),
  {
    title: "Audit Result",
    description: "Returns the canonical JSON audit artifact for a persisted audit ID.",
    mimeType: "application/json"
  },
  async (uri, { auditId }) => {
    const artifact = await engine.get(String(auditId));

    if (!artifact) {
      throw new Error(`Audit not found for ${uri.href}`);
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(artifact, null, 2)
        }
      ]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
