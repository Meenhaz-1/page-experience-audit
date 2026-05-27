import crypto from "node:crypto";
import { URL } from "node:url";
import path from "node:path";

const AUDIT_RUNS_DIR = "runs";

export function createAuditId(url: string): string {
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `audit_${new Date().toISOString().replace(/[:.]/g, "-")}_${hash}`;
}

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  return url.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function roundMegabytes(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(3));
}

export function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").slice(0, 60);
}

export function auditRunDir(auditsDir: string, auditId: string): string {
  return path.join(auditsDir, AUDIT_RUNS_DIR, sanitizeFilenamePart(auditId));
}

export function auditArtifactPath(auditsDir: string, auditId: string, filename = "artifact.json"): string {
  return path.join(auditRunDir(auditsDir, auditId), filename);
}

export function auditReportsDir(auditsDir: string, auditId: string): string {
  return path.join(auditRunDir(auditsDir, auditId), "reports");
}

export function auditLogPath(auditsDir: string, auditId: string): string {
  return path.join(auditRunDir(auditsDir, auditId), "audit.log");
}

export function auditTracePath(auditsDir: string, auditId: string): string {
  return path.join(auditRunDir(auditsDir, auditId), "trace.json");
}

export function auditHeapSnapshotPath(auditsDir: string, auditId: string): string {
  return path.join(auditRunDir(auditsDir, auditId), "heap.heapsnapshot");
}

export function defaultAuditLogPath(auditId: string): string {
  return auditLogPath("audits", auditId);
}
