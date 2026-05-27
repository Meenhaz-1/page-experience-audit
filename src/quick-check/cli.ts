import process from "node:process";

import "../env.js";
import { runAuditInputSchema } from "../core/index.js";
import { runQuickCheck } from "./core.js";

function parseArgs(argv: string[]) {
  const [url, ...rest] = argv;
  const options: Record<string, unknown> = { url };
  let flowDescription: string | undefined;

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
    } else if (arg === "--ai-mode" && next) {
      options.aiMode = next;
      index += 1;
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
    } else if (arg === "--flow-description" && next) {
      flowDescription = next;
      index += 1;
    }
  }

  return { options, flowDescription };
}

function reportProgress(message: string): void {
  if (message.startsWith("tool:")) {
    return;
  }
  process.stderr.write(`[quick-check] ${message}\n`);
}

async function main() {
  try {
    const { options, flowDescription } = parseArgs(process.argv.slice(2));
    const parsed = runAuditInputSchema.parse(options);
    const artifact = await runQuickCheck({ ...parsed, flowDescription }, reportProgress);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Quick check failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

void main();
