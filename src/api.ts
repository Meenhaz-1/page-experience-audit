import express from "express";

import "./env.js";
import { getAuditInputSchema, runAuditInputSchema } from "./core/index.js";
import { createAuditEngine } from "./engine.js";

export function createApiApp() {
  const app = express();
  const engine = createAuditEngine();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/audits", async (req, res) => {
    try {
      const input = runAuditInputSchema.parse(req.body);
      const artifact = await engine.run(input);
      res.status(200).json(artifact);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/audits/:auditId", async (req, res) => {
    try {
      const { auditId } = getAuditInputSchema.parse(req.params);
      const artifact = await engine.get(auditId);

      if (!artifact) {
        res.status(404).json({ error: "Audit not found" });
        return;
      }

      res.status(200).json(artifact);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PAGE_AUDIT_PORT ?? 3000);
  const app = createApiApp();
  app.listen(port, () => {
    process.stdout.write(`Page Audit API listening on port ${port}\n`);
  });
}
