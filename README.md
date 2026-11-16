# Characterize

**Document application behavior from browser journeys.** Give Characterize a starting URL and a flow to explore. An AI agent drives Chromium through Playwright MCP, records business rules as it discovers them, and writes tests for the behavior it observes.

[Quick start](#quick-start) · [First exploration](#your-first-exploration) · [Coverage](#coverage) · [Local data](#local-data)

![Characterize in dark mode showing the exploration form and its four coverage levels](docs/workspace-dark.png)

## Quick start

Use Node.js 22.18 or later and npm on macOS or Linux. From the project directory, run:

```sh
npm ci
npm run setup:browser
npm run dev
```

Open [the local workspace](http://127.0.0.1:4320). Connect **one Codex, Claude or GitHub Copilot account** in Settings. Sign-in opens in your browser through the provider’s official CLI. An existing Codex or Claude session can also be reused.

## Your first exploration

1. **Pick a site.** For a first run, start `npm run demo` in another terminal and enter [the local demo URL](http://127.0.0.1:4321) in Characterization.
2. **Give the agent a task.** Try “Open the catalog, apply a filter and describe how the product list changes.” Choose a coverage level, model and reasoning effort. Optional context can include written instructions and local directories containing skills or guardrails.
3. **Watch the journey.** Follow the actions as they arrive. The agent may follow redirects within the same registrable domain, including subdomains. When a flow leads to another domain, it records the destination and returns to the original site.
4. **Review the evidence.** Open **Local library** for Gherkin scenarios grouped by site and screen. **Smoke** groups journeys spanning several screens. An interrupted exploration can still yield draft scenarios from recorded page observations. Open its diagnostics for failed actions and the local Playwright Trace Viewer when a trace is available.
5. **Run the tests.** Download the suite ZIP from a completed exploration and review its TypeScript assertions. In the extracted directory, run `npm install`, `npx playwright install chromium` and `npm test` to verify the generated suite.

Open **Application map** to explore a graph of screens, contained components, interactive elements, navigations and business rules. Repeated visible boundaries become shared entities connected to their screens. Double-click a screen to inspect its components and pending alternatives, then focus a component to see its elements. Select an entity for its evidence. Existing runs contribute their recorded snapshots and reports.

Enable **Generate service map** before exploring to add browser destinations and their operations to the graph. Select an operation to inspect captured results, durations and available action evidence. Partial captures show their limits. Gateways appear as observed destinations, and unknown route segments are grouped for privacy.

**Prioritize unexplored paths** uses documented scenarios, historical gaps and untried controls to guide the next exploration. The agent keeps decision points, backtracks to try sibling paths and saves each observed condition/action/outcome with `record_discovery`. Product, market, currency and other sample values belong to examples. Market-dependent rules retain their observed scope. Disable the option to recheck known flows.

After three minutes without provider output, browser evidence or recorded discoveries, the worker stops and retains its recorded evidence and rules. Recorded rules remain available in the library and graph when the final report is incomplete. The library groups repeated scenarios with matching clauses and screens, and keeps their individual observations accessible.

## Coverage

| Level | What to explore | Action budget | Time budget |
| --- | --- | ---: | ---: |
| Smoke | Entry points and main flows | 30 | 8 min |
| Functional | Common user journeys | 80 | 20 min |
| Detailed | Variations, states and validation | 160 | 40 min |
| Exhaustive | Edge cases and alternative paths | 280 | 60 min |

Each report lists remaining gaps. Choose a visible browser if you need to sign in to the target site during exploration.

## Local data

The server listens on loopback. Settings, run history, evidence, traces and Gherkin files live under `.data/`, which Git ignores. A fresh clone starts with an empty library. The theme follows your system on first visit, and the appearance button saves your choice in the browser.

Your selected AI provider receives the prompt, selected context and browser observations. **Review files** in Settings shows which context documents will be included. Provider credentials stay in the official CLI stores. Traces and exported suites can contain page content and form data, so review them before sharing.

| Setting | Purpose |
| --- | --- |
| `PORT` | Change the local server port (default `4320`) |
| `CHARACTERIZE_DATA_DIR` | Choose a different data directory |

## Development

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The browser tests use fixture data and run without an AI subscription. To serve the compiled application, run `npm start` after the build. The platform prefers CLIs available on your PATH and bundles pinned versions as a fallback.

[Design notes (Spanish)](docs/SDD.md) · [Validation notes (Spanish)](docs/validation.md) · [Playwright MCP](https://github.com/microsoft/playwright-mcp)
