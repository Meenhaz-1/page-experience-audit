import fs from "node:fs/promises";
import path from "node:path";

export type AuditProgressSink = (message: string, extra?: unknown) => void | Promise<void>;

export class AuditLogger {
  constructor(
    private readonly filePath: string,
    private readonly progressSink?: AuditProgressSink
  ) {}

  get path(): string {
    return this.filePath;
  }

  async log(message: string, extra?: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const line =
      extra === undefined
        ? `[${timestamp}] ${message}\n`
        : `[${timestamp}] ${message} ${safeSerialize(extra)}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf8");
    await this.progressSink?.(message, extra);
  }
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
