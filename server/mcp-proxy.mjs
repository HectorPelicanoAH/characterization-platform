// The agent talks to this audited stdio bridge, which calls the official Playwright MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  sameDomain,
  pageUrlFromResult,
  externalUrlsFromResult,
} from "./domain.mjs";
import { chromium } from "@playwright/test";

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
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listed.tools.filter((tool) => allowed.has(tool.name)),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const id = ++count;
  const tool = request.params.name;
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
    const result = await client.callTool(request.params, undefined, {
      timeout: 60000,
    });
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
    appendFileSync(
      config.evidencePath,
      JSON.stringify({
        id,
        tool,
        at: new Date().toISOString(),
        ok: !result.isError,
        ...(typeof request.params.arguments?.element === "string" ? { element: request.params.arguments.element.slice(0, 160) } : {}),
        detail,
        ...(externalUrls.length
          ? { externalUrl: externalUrls[0], externalUrls }
          : {}),
      }) + "\n",
      { mode: 0o600 },
    );
    return {
      ...result,
      content: [
        ...content,
        {
          type: "text",
          text: `CHARACTERIZATION_EVIDENCE_ID=${id}. Cite this ID only for behavior observed in this response.${externalUrls.length ? ` EXTERNAL REDIRECT: ${externalUrls.join(", ")}. Document the triggering action and each destination as a flow with a URL assertion. Return to the original tab or go back before continuing.` : ""}`,
        },
      ],
    };
  } catch (error) {
    appendFileSync(
      config.evidencePath,
      JSON.stringify({
        id,
        tool,
        at: new Date().toISOString(),
        ok: false,
        detail: error.message,
      }) + "\n",
      { mode: 0o600 },
    );
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if(traceStarted) await client.callTool({name:"browser_stop_tracing",arguments:{}},undefined,{timeout:5000}).catch(()=>{});
  await client.close().catch(() => {});
  process.exit(0);
}
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
