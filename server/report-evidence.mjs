// Read-only access to the existing recording. No browser or file-writing tools.
import { readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const observations = readFileSync(config.evidencePath, "utf8").split("\n").flatMap(line => {
  try { const event = JSON.parse(line); return event.ok ? [event] : []; } catch { return []; }
});
const lookup = z.object({ ids: z.array(z.number().int().positive()).min(1).max(6) });
const search = z.object({ query: z.string().min(1).max(200) });
const server = new Server({ name: "characterize-recording", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "get_saved_evidence", description: "Read full successful observations by their original evidence IDs. Use for missing prerequisites, cookie consent, bag setup, navigation, labels and outcomes. Reads the saved recording only.", inputSchema: z.toJSONSchema(lookup) },
  { name: "search_saved_evidence", description: "Find existing successful observations by visible label, element, page URL or text. Returns IDs to open with get_saved_evidence. No new browser interactions occur.", inputSchema: z.toJSONSchema(search) },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (config.activityPath) writeFileSync(config.activityPath, new Date().toISOString(), { mode: 0o600 });
    let result;
    if (request.params.name === "get_saved_evidence") {
      const { ids } = lookup.parse(request.params.arguments);
      if (ids.some(id => !observations.some(event => event.id === id))) throw Error("Choose successful evidence IDs from the saved recording.");
      result = observations.filter(event => ids.includes(event.id));
    } else if (request.params.name === "search_saved_evidence") {
      const { query } = search.parse(request.params.arguments);
      const matches = observations.filter(event => ((event.element ?? "") + " " + event.detail).toLowerCase().includes(query.toLowerCase()));
      result = { matches: matches.length, observations: matches.slice(0, 25).map(event => ({ id: event.id, tool: event.tool, element: event.element, detail: event.detail.slice(0, 900) })) };
    } else throw Error("Only reading saved evidence is supported.");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
