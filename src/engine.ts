import { AuditEngine, OpenAiProvider, type AuditProgressSink } from "./core/index.js";

export function createAuditEngine(progressSink?: AuditProgressSink): AuditEngine {
  const apiKey = process.env.OPENAI_API_KEY;
  const aiProvider = apiKey ? new OpenAiProvider(apiKey) : undefined;

  return new AuditEngine({ aiProvider, progressSink });
}
