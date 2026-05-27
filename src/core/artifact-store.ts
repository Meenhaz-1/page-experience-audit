import fs from "node:fs/promises";
import path from "node:path";

import { renderAiReportHtml } from "./ai-report-renderer.js";
import { DEFAULT_AUDITS_DIR } from "./defaults.js";
import type { AuditArtifact, StoredArtifactRecord } from "./types.js";
import { auditArtifactPath, auditReportsDir } from "./utils.js";

export class ArtifactStore {
  constructor(private readonly baseDir = DEFAULT_AUDITS_DIR) {}

  async persist(artifact: AuditArtifact): Promise<StoredArtifactRecord> {
    const runDir = path.dirname(auditArtifactPath(this.baseDir, artifact.auditId));
    const artifactPath = auditArtifactPath(this.baseDir, artifact.auditId);
    const reportDir = auditReportsDir(this.baseDir, artifact.auditId);
    const markdownPath =
      artifact.aiOutput?.markdownReport != null ? path.join(reportDir, "report.md") : null;
    const htmlReportPath =
      artifact.aiOutput != null ? path.join(reportDir, "summary.html") : null;

    await fs.mkdir(runDir, { recursive: true });

    if (artifact.aiOutput) {
      await fs.mkdir(reportDir, { recursive: true });
      artifact.aiOutput.markdownReportPath = markdownPath;
      artifact.aiOutput.htmlReportPath = htmlReportPath;
    }

    await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

    if (markdownPath && artifact.aiOutput?.markdownReport) {
      await fs.writeFile(markdownPath, artifact.aiOutput.markdownReport, "utf8");
    }

    if (htmlReportPath) {
      const html = renderAiReportHtml(artifact);
      if (html) {
        await fs.writeFile(htmlReportPath, html, "utf8");
      }
    }

    return {
      artifact,
      artifactPath,
      markdownPath,
      htmlReportPath
    };
  }

  async get(auditId: string): Promise<AuditArtifact | null> {
    const artifactPath = auditArtifactPath(this.baseDir, auditId);
    const legacyArtifactPath = path.join(this.baseDir, `${auditId}.json`);

    try {
      const content = await fs.readFile(artifactPath, "utf8");
      return JSON.parse(content) as AuditArtifact;
    } catch {
      try {
        const content = await fs.readFile(legacyArtifactPath, "utf8");
        return JSON.parse(content) as AuditArtifact;
      } catch {
        return null;
      }
    }
  }
}
