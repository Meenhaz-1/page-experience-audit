import process from "node:process";

import "../env.js";
import { runAuditInputSchema } from "../core/index.js";
import { runUsabilityAudit } from "./core.js";

function parseArgs(argv: string[]) {
  const [url, ...rest] = argv;
  const options: Record<string, unknown> = { url };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];

    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--settle-ms" && next) {
      options.settleTimeMs = Number(next);
      index += 1;
    } else if (arg === "--cpu-throttle" && next) {
      options.cpuThrottleRate = Number(next);
      index += 1;
    } else if (arg === "--device-profile" && next) {
      options.deviceProfile = next;
      index += 1;
    } else if (arg === "--light-mode") {
      options.lightMode = true;
    } else if (arg === "--no-lighthouse") {
      options.includeLighthouse = false;
    } else if (arg === "--no-memory") {
      options.includeMemory = false;
    } else if (arg === "--no-console") {
      options.includeConsole = false;
    } else if (arg === "--no-eval") {
      options.includeEvaluation = false;
    } else if (arg === "--no-scroll-profile") {
      options.includeScrollProfile = false;
    } else if (arg === "--launch-managed-browser") {
      options.launchManagedBrowser = true;
    } else if (arg === "--scroll-steps" && next) {
      options.scrollSteps = Number(next);
      index += 1;
    } else if (arg === "--scroll-pause-ms" && next) {
      options.scrollPauseMs = Number(next);
      index += 1;
    } else if (arg === "--browser-url" && next) {
      options.browserUrl = next;
      index += 1;
    } else if (arg === "--log-file" && next) {
      options.logFile = next;
      index += 1;
    }
  }

  return options;
}

function reportProgress(message: string): void {
  if (message.startsWith("tool:")) {
    return;
  }
  process.stderr.write(`[usability] ${message}\n`);
}

async function main() {
  try {
    const parsed = runAuditInputSchema.parse(parseArgs(process.argv.slice(2)));
    const artifact = await runUsabilityAudit(parsed, reportProgress);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Usability audit failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

void main();
