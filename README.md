# Page Audit

`page-audit` is an MCP-first web auditing tool for teams that need more than a single Lighthouse score. It runs Chrome DevTools-backed audits, captures canonical JSON artifacts, and optionally turns those artifacts into AI summaries or reports.

## The Problem

Modern page regressions are often messy:

- Lighthouse may flag a symptom without explaining scroll-time memory growth, console instability, or runtime DOM expansion.
- Manual DevTools sessions are powerful, but they are hard to repeat consistently across pages, environments, and teammates.
- One-off scripts usually collect partial signals and produce outputs that are difficult to compare, persist, or feed into other tools.

`page-audit` solves that by orchestrating Chrome DevTools MCP tools into a repeatable audit workflow that can be run from the CLI, an API, or an MCP server.

## Why Existing Solutions Fall Short

- Lighthouse-first workflows are useful for snapshots, but they do not fully cover runtime memory behavior, scroll profiling, or richer debugging evidence.
- Pure manual debugging in Chrome gives good local insight, but it is not a durable audit pipeline and does not naturally produce structured artifacts for automation.
- Many performance tools focus on one surface area at a time. Real regressions often span trace behavior, memory retention, console noise, failed requests, layout instability, and third-party script impact together.

This project combines those signals into a single persisted artifact so you can inspect one run, compare two URLs, or layer AI synthesis on top without rebuilding the collection pipeline each time.

## Features

- Shared audit core for CLI, API, and MCP usage
- `chrome-devtools-mcp` orchestration for trace, insight, heap, console, evaluation, and Lighthouse collection
- Canonical JSON audit artifacts with optional AI-generated summaries/reports
- Filesystem-backed artifact persistence and retrieval

## Supported Tests

`page-audit` supports a few different audit workflows depending on what you need to learn.

### 1. Standard Performance Audit

Run with `npm run audit -- <url>`.

This is the default full audit and can collect:

- performance trace data and trace insights
- Lighthouse results
- heap snapshot and memory summaries
- console messages
- network request evidence
- page evaluation output
- scroll profiling, including heap growth, DOM growth, and CLS during scroll

### 2. Lightweight Diagnostic Audit

Run with `--light-mode`.

This keeps the workflow lower pressure by switching to a desktop-oriented profile and disabling CPU throttling, which is useful when you want to validate tool health or get quick signals before a heavier mobile-style run.

### 3. Phased Audit

Run with `--phased`.

This breaks the audit into stages:

- lightweight coverage first
- memory analysis next
- Lighthouse last, only if earlier phases were healthy enough

This is useful when you want safer long-running audits and clearer failure boundaries.

### 4. Side-by-Side Comparison Audit

Run with `--compare-url`.

This executes the same workflow against two URLs and generates a comparison artifact that focuses on relative differences such as:

- live DOM size
- heap graph size
- warning volume
- peak scroll heap usage
- DOM growth during scroll
- scroll-time layout shift

### 5. Usability Audit

Run with `npm run usability -- <url>`.

This produces a usability-oriented interpretation of the collected DevTools evidence across:

- load experience
- scroll experience
- interaction readiness
- visual stability
- reliability
- memory pressure
- accessibility

### 6. Quick Check Report

Run with `npm run quick-check -- <url>`.

This produces a stakeholder-friendly fail-soft HTML summary report focused on:

- plain-English executive status
- phase-by-phase collection results
- console and network health
- trace-backed performance signals
- DOM, iframe, and image counts
- short-window rerender churn via DOM mutation tracking
- practical next actions and limitations

### 7. Optional AI Synthesis

AI synthesis is not a separate collection mode, but it can be added to audit runs with `--ai-mode`.

- `disabled`: raw audit artifact only
- `structured_summary`: concise structured summary for engineering triage
- `markdown_report`: fuller narrative report for sharing and review

## Requirements

- Node.js 22+
- `OPENAI_API_KEY` only if AI synthesis is enabled

## Install

```bash
npm install
cp .env.example .env
```

## Run

CLI:

```bash
npm run audit -- https://example.com
```

Example `.env`:

```bash
OPENAI_API_KEY=your_key_here
PAGE_AUDIT_MODEL=gpt-4.1
PAGE_AUDIT_PORT=3000
PAGE_AUDIT_MCP_BROWSER_URL=http://127.0.0.1:9222
PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER=false
PAGE_AUDIT_MCP_LOG_FILE=audits/shared/page-audit.log
```

CLI with AI structured summary:

```bash
npm run audit -- https://example.com --ai-mode structured_summary
```

Lightweight diagnostic run:

```bash
npm run audit -- https://example.com --light-mode --ai-mode structured_summary
```

Phased run:

```bash
npm run audit -- https://example.com --phased --ai-mode structured_summary
```

Comparison run:

```bash
npm run audit -- https://example.com --compare-url https://staging.example.com
```

CLI with full markdown report:

```bash
npm run audit -- https://example.com --ai-mode markdown_report
```

Usability-focused DevTools-backed audit:

```bash
npm run usability -- https://example.com
```

Quick check report:

```bash
npm run quick-check -- https://example.com --flow-description "Open the page, wait for content, then perform a short representative scroll."
```

Quick check with AI summary:

```bash
npm run quick-check -- https://example.com --ai-mode structured_summary
```

API:

```bash
npm run api
```

MCP server:

```bash
npm run mcp
```

## Environment

- `OPENAI_API_KEY`: required for `structured_summary` and `markdown_report`
- `PAGE_AUDIT_MODEL`: optional OpenAI model override
- `PAGE_AUDIT_PORT`: optional API port, defaults to `3000`
- `PAGE_AUDIT_LIGHT_MODE`: optional boolean override; when `true`, default runs use a desktop profile and disable CPU throttling for diagnosis
- `PAGE_AUDIT_MCP_BROWSER_URL`: optional Chrome remote debugging URL for attaching to a manually started browser
- `PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER`: optional boolean override; when `true`, the audit ignores `PAGE_AUDIT_MCP_BROWSER_URL` and lets `chrome-devtools-mcp` launch Chrome itself
- `PAGE_AUDIT_MCP_LOG_FILE`: optional shared log file path for MCP server output
- Environment variables are automatically loaded from `.env`

## AI Synthesis

The audit engine supports three AI modes:

- `disabled`: collect DevTools MCP outputs only
- `structured_summary`: return a structured AI summary with:
  - `headline`
  - `overallAssessment`
  - `primaryBottlenecks`
  - `recommendedActions`
- `markdown_report`: return a full markdown performance report

The AI result is stored in the audit artifact under `aiOutput`.

Example API request with AI synthesis:

```bash
curl -X POST http://localhost:3000/audits \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "aiMode": "structured_summary"
  }'
```

Example MCP tool input:

```json
{
  "url": "https://example.com",
  "aiMode": "markdown_report"
}
```

## Notes

- By default the audit engine spawns `chrome-devtools-mcp` via `npx`.
- The default MCP command includes `--isolated=true` to avoid shared-profile conflicts between concurrent sessions.
- The default MCP command includes `--experimentalPageIdRouting=true` so page-scoped tools can be routed more reliably.
- The default MCP command includes `--experimentalMemory=true` and `--experimentalStructuredContent=true` so the heap snapshot and structured trace tools are exposed when supported.
- Each run now writes into `audits/runs/<auditId>/...`, including `artifact.json`, `trace.json`, `heap.heapsnapshot`, and `reports/` when those outputs are available.
- Every audit writes a local log file to `audits/runs/<auditId>/audit.log` unless you override it with `PAGE_AUDIT_MCP_LOG_FILE` or `--log-file`.
- Use `--light-mode` when you want a lower-pressure diagnostic run. It switches the defaults to a desktop profile and `--cpu-throttle 1` so you can confirm tooling health before trying mobile-throttled runs.
- Use `--phased` when you want the CLI to automatically run the audit in stages: lightweight coverage first, then memory, then Lighthouse only if the earlier phase was healthy enough.
- Use `--launch-managed-browser` when you want the audit to ignore any configured `browserUrl` and let `chrome-devtools-mcp` launch Chrome directly. This is the recommended mode when you need page-scoped tools like `evaluate_script` and scroll profiling to work reliably.
- When you use `--browser-url`, the CLI now preflights `http://.../json/version` before phased and compare runs. If Chrome is not reachable, the command fails early instead of producing a misleading partial comparison.
- Use `npm run usability -- ...` when you want a separate usability-oriented report that focuses on load experience, scroll experience, interaction readiness, visual stability, reliability, memory pressure, and accessibility using only DevTools-backed signals.

## Manual Chrome Attach

To use a manually started Chrome instance instead of letting `chrome-devtools-mcp` launch one, start Chrome with remote debugging enabled and a non-default user data directory:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-page-audit
```

Then either set this in `.env`:

```bash
PAGE_AUDIT_MCP_BROWSER_URL=http://127.0.0.1:9222
```

or pass it directly:

```bash
npm run audit -- https://www.wired.com/ --browser-url http://127.0.0.1:9222
```

You can verify the debugging endpoint yourself before running a compare:

```bash
curl http://127.0.0.1:9222/json/version
```

## Managed Browser Mode

If you want `chrome-devtools-mcp` to launch Chrome directly instead of attaching to a manually started browser, either:

```bash
npm run audit -- https://example.com --launch-managed-browser
```

or set:

```bash
PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER=true
```

Managed browser mode is the preferred path for scroll profiling because it more reliably enables page-scoped evaluation.
