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
- Stakeholder-friendly quick-check HTML reports with layered reading depth:
  - `30 seconds`: decision layer, top risks, ownership, priority
  - `2 minutes`: user journey, key metrics, root causes, actions
  - `10+ minutes`: logs, traces, evidence, engineering appendix
- Decision-ready report framing with:
  - critical alert banners
  - `P0` to `P3` issue prioritization
  - severity, timing, confidence, ownership, and blast-radius tagging
- User-journey interpretation across:
  - `Page Opens Reliably`
  - `Content Stays Stable`
  - `Scrolling Feels Smooth`
  - `Page Feels Responsive`
  - `Session Stays Stable`
- Third-party CPU attribution from saved Chrome traces, including per-vendor main-thread time

## Quick Start

```bash
npm install
cp .env.example .env
npm run quick-check:chrome:ai -- https://example.com \
  --flow-description "Open the page, wait for content, then perform a short representative scroll."
```

Requirements:

- Node.js 22+
- `OPENAI_API_KEY` only when AI synthesis is enabled

## Commands

| Goal | Command |
| --- | --- |
| Standard audit | `npm run audit -- <url>` |
| Quick-check HTML report | `npm run quick-check:chrome:ai -- <url> --flow-description "<flow>"` |
| Lightweight diagnostic | `npm run audit -- <url> --light-mode` |
| Phased audit | `npm run audit -- <url> --phased` |
| Compare URLs | `npm run audit -- <url> --compare-url <other-url>` |
| Usability audit | `npm run usability -- <url>` |
| API server | `npm run api` |
| MCP server | `npm run mcp` |

## Report Output

Quick-check reports are layered for different audiences:

- `30 seconds`: executive summary, critical alerts, top risks, priority, owner, confidence
- `2 minutes`: user journey, key metrics, third-party CPU impact, memory/DOM scan, recommendations
- `10+ minutes`: console, network, trace evidence, logs, prompts, engineering appendix

Sample report:

[View rendered sample quick-check report](https://meenhaz-1.github.io/page-experience-audit/sample-reports/quick-check/amazon-in/summary.html)

## AI Modes

- `disabled`: raw DevTools artifact only
- `structured_summary`: concise AI summary for triage and quick-check reports
- `markdown_report`: fuller narrative report

Use `--ai-mode structured_summary` or `--ai-mode markdown_report`.

## Chrome Modes

The easiest path is attached Chrome with auto-start:

```bash
npm run quick-check:chrome:ai -- https://example.com \
  --flow-description "Open the page, wait for content, then perform a short representative scroll."
```

You can also attach manually:

```bash
npm run quick-check -- https://example.com \
  --browser-url http://127.0.0.1:9222 \
  --ai-mode structured_summary \
  --flow-description "Open the page, wait for content, then perform a short representative scroll."
```

Or let MCP launch Chrome:

```bash
npm run audit -- https://example.com --launch-managed-browser
```

## Configuration

Environment variables are loaded from `.env`.

```bash
OPENAI_API_KEY=your_key_here
PAGE_AUDIT_MODEL=gpt-4.1
PAGE_AUDIT_PORT=3000
PAGE_AUDIT_MCP_BROWSER_URL=http://127.0.0.1:9222
PAGE_AUDIT_MCP_LAUNCH_MANAGED_BROWSER=false
PAGE_AUDIT_MCP_LOG_FILE=audits/shared/page-audit.log
```

## Output Layout

```text
audits/
  runs/
    <audit-or-report-id>/
      artifact.json
      audit.log
      trace.json
      heap.heapsnapshot
      reports/
        summary.html
```

Some files appear only when that phase completes successfully.
