// The agent talks to this audited stdio bridge, which calls the official Playwright MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  sameDomain,
  pageUrlFromResult,
  externalUrlsFromResult,
} from "./domain.mjs";
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { discoverySchema } from "../shared/discovery.ts";
import { ExplorationInventory } from "./snapshot.ts";

const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const allowed = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_tabs",
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_wait_for",
  "browser_handle_dialog",
]);
const cli = join(
  dirname(require.resolve("@playwright/mcp/package.json")),
  "cli.js",
);
const args = [
  cli,
  "--executable-path",
  chromium.executablePath(),
  "--caps","devtools",
  "--isolated",
  "--block-service-workers",
  "--no-webmcp",
  "--redact-url-params",
  "access_token,token,code,id_token,refresh_token",
  "--output-dir",
  config.outputDir,
];
if (!config.headed) args.push("--headless");
const client = new Client({ name: "characterize-bridge", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args,
  stderr: "inherit",
});
await client.connect(transport);
const listed = await client.listTools();
let traceStarted = false;
let traceAttempted = false;
const server = new Server(
  { name: "characterize-playwright", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
let count = 0;
let externalUrl;
const inventory = new ExplorationInventory();
const discoveries = new Map();
let discoveryWrites = 0;
const readEvidence = () => {
  if (!existsSync(config.evidencePath)) return [];
  return readFileSync(config.evidencePath, "utf8").split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
};
const extraTools = [
  { name: "record_discovery", description: "Save one observed business rule immediately. Use a reusable capability key and general condition/action/outcome. Put country, product and numeric samples in examples. Cite successful evidence from this run.",
    inputSchema: z.toJSONSchema(discoverySchema) },
  { name: "get_discovery_plan", description: "List observed screens, untried controls, exercised paths and recorded capabilities. Use it to backtrack and select an alternative branch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...listed.tools.filter((tool) => allowed.has(tool.name)), ...extraTools],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_discovery_plan")
    return { content: [{ type: "text", text: JSON.stringify({
      screens: inventory.plan().map(screen=>({...screen,pendingCount:screen.pending.length,pending:screen.pending.slice(0,screen.current?20:8)})),
      recordedRuleCount: discoveries.size,
      recentRules: [...discoveries.values()].slice(-30).map(d => ({ capability: d.capability, given: d.given, observed: d.observed.slice(0,300) })),
    }) }] };
  if (request.params.name === "record_discovery") {
    try {
      if (discoveryWrites >= 320) throw Error("Discovery recording budget exhausted. Finish the report.");
      const discovery = discoverySchema.parse(request.params.arguments);
      const successful = new Map(readEvidence().filter(e => e.ok).map(e => [e.id, e]));
      if (discovery.evidenceIds.some(id => !successful.has(id)) ||
          !pageUrlFromResult(successful.get(discovery.screenEvidenceId)?.detail ?? ""))
        throw Error("Cite successful evidence and a page observation from this run.");
      const id = createHash("sha256").update(JSON.stringify([discovery.capabilityKey, discovery.scope, discovery.given, discovery.action, discovery.observed])).digest("hex").slice(0, 24);
      if (!discoveries.has(id) && discoveries.size >= 160) throw Error("Discovery limit reached. Finish the report.");
      const previous = discoveries.get(id);
      const saved = { ...discovery, id, at: new Date().toISOString(),
        evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...discovery.evidenceIds])].slice(0,30),
        screenEvidenceIds: [...new Set([...(previous?.screenEvidenceIds ?? []), discovery.screenEvidenceId])],
        examples: [...new Map([...(previous?.examples ?? []), ...discovery.examples].map(example => [JSON.stringify(example), example])).values()].slice(0,12),
      };
      appendFileSync(join(config.outputDir, "discoveries.jsonl"), JSON.stringify(saved) + "\n", { mode: 0o600 });
      discoveryWrites++;
      discoveries.set(id, saved);
      return { content: [{ type: "text", text: "Discovery saved. " + discoveries.size + " distinct rules recorded. Backtrack to pending alternatives with get_discovery_plan." }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
  const id = ++count;
  const tool = request.params.name;
  let startedAt;
  try {
    if (!allowed.has(tool)) throw new Error("Tool outside the exploration scope.");
    if (count > config.maxCalls)
      throw new Error(
        "Exploration budget exhausted. Finish the report using recorded observations.",
      );
    if (
      externalUrl &&
      ![
        "browser_navigate",
        "browser_navigate_back",
        "browser_snapshot",
        "browser_tabs",
      ].includes(tool)
    )
      throw new Error(
        `External redirect recorded: ${externalUrl}. Record the case and return to the original site before continuing.`,
      );
    if (
      tool === "browser_tabs" &&
      !["list", "select", "close"].includes(request.params.arguments?.action)
    )
      throw new Error(
        "List, select or close tabs here. Open pages with browser_navigate.",
      );
    if (tool === "browser_navigate") {
      const url = new URL(String(request.params.arguments?.url));
      if (!sameDomain(url.href, config.origin) || url.username || url.password)
        throw new Error(
          "Explicit navigation must stay on the configured domain. Document external redirects as cases.",
        );
    }
    if (!traceAttempted) {
      traceAttempted = true;
      try {
        const trace = await client.callTool({name:"browser_start_tracing",arguments:{}});
        traceStarted = !trace.isError;
      } catch { /* Evidence remains available if the browser cannot record. */ }
    }
    startedAt = new Date().toISOString();
    const result = await client.callTool(request.params, undefined, {
      timeout: 60000,
    });
    const finishedAt = new Date().toISOString();
    const content = Array.isArray(result.content) ? result.content : [];
    const fullDetail = content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const detail = fullDetail.slice(0, 12000);
    const pageUrl = pageUrlFromResult(fullDetail);
    const externalUrls = externalUrlsFromResult(fullDetail, config.origin);
    if (pageUrl)
      externalUrl = sameDomain(pageUrl, config.origin) ? undefined : pageUrl;
    const event = {
      id, tool, at: new Date().toISOString(), ok: !result.isError,
      ...(config.serviceMapEnabled ? { startedAt, finishedAt } : {}),
      ...(typeof request.params.arguments?.element === "string" ? { element: request.params.arguments.element.slice(0, 160) } : {}),
      detail, ...(externalUrls.length ? { externalUrl: externalUrls[0], externalUrls } : {}),
    };
    const observed = inventory.observe({ ...event, detail: fullDetail }, request.params.arguments?.target ?? request.params.arguments?.ref);
    if (observed.observation) {
      appendFileSync(join(config.outputDir, "interface.jsonl"), JSON.stringify({
        ...observed.observation, action: observed.action,
      }) + "\n", { mode: 0o600 });
    }
    appendFileSync(
      config.evidencePath,
      JSON.stringify(event) + "\n",
      { mode: 0o600 },
    );
    return {
      ...result,
      content: [
        ...content,
        {
          type: "text",
          text: `CHARACTERIZATION_EVIDENCE_ID=${id}. Cite this ID only for behavior observed in this response.${externalUrls.length ? ` EXTERNAL REDIRECT: ${externalUrls.join(", ")}. Document the triggering action and each destination as a flow with a URL assertion. Return to the original tab or go back before continuing.` : ""}
DISCOVERY_FRONTIER ${JSON.stringify(inventory.plan().map(screen => ({ screen: screen.screen, current: screen.current, pending: screen.pending.length, exercised: screen.exercised, alternatives: screen.pending.slice(0, screen.current ? 6 : 0) })))}. Save each new rule with record_discovery before continuing. Backtrack to pending alternatives.`,
        },
      ],
    };
  } catch (error) {
    inventory.observe({ id, tool, at: new Date().toISOString(), ok: false, detail: error.message },
      request.params.arguments?.target ?? request.params.arguments?.ref);
    appendFileSync(
      config.evidencePath,
      JSON.stringify({
        id,
        tool,
        at: new Date().toISOString(),
        ok: false,
        detail: error.message,
        ...(config.serviceMapEnabled && startedAt ? { startedAt, finishedAt: new Date().toISOString() } : {}),
      }) + "\n",
      { mode: 0o600 },
    );
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
let closing = false;
let traceStop;
function stopTracing() {
  if (traceStop) return traceStop;
  traceStop = (async () => {
    let closed = false;
    if (traceStarted) {
      const result = await client.callTool({name:"browser_stop_tracing",arguments:{}},undefined,{timeout:4000}).catch(()=>null);
      closed = !!result && !result.isError;
    }
    if (config.serviceMapEnabled) {
      const file = join(config.outputDir, "service-map-trace.json");
      writeFileSync(file + ".tmp", JSON.stringify({ closed }), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    }
  })();
  return traceStop;
}
const stopTimer = config.serviceMapEnabled ? setInterval(() => {
  if (existsSync(join(config.outputDir, "service-map-stop"))) void stopTracing().catch(() => {});
}, 100) : undefined;
stopTimer?.unref();
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(stopTimer);
  await stopTracing().catch(() => {});
  await client.close().catch(() => {});
  process.exit(0);
}
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
