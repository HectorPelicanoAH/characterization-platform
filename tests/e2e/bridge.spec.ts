import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildServiceMap } from "../../server/service-map";
import { runInputSchema } from "../../shared/model";
import type { Evidence, Run } from "../../shared/model";

test("official MCP follows same-domain redirects and records external destinations before blocking further interaction", async ({
  page, request,
}) => {
  test.setTimeout(90000);
  const id = randomUUID();
  const dir = join("/private/tmp/characterize-e2e-data/runs", id);
  await mkdir(dir, { recursive: true });
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/catalog" });
      res.end();
      return;
    }
    if (req.url === "/external") {
      res.writeHead(302, {
        Location: `http://localhost:${(server.address() as { port: number }).port}/destination`,
      });
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><head><title>Fixture</title></head><body><h1>${req.url === "/destination" ? "External destination" : "Catalog"}</h1><a href="/external">External checkout</a><a target="_blank" href="/external">Open external tab</a><button>Do not click outside domain</button></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = join(dir, "bridge.json");
  await writeFile(
    config,
    JSON.stringify({
      origin: base,
      headed: false,
      maxCalls: 10,
      outputDir: dir,
      evidencePath: join(dir, "evidence.jsonl"),
    }),
  );
  const client = new Client({
    name: "characterize-integration-test",
    version: "1",
  });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("server/mcp-proxy.mjs"), config],
        stderr: "pipe",
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "browser_evaluate")).toBe(false);
    expect(tools.tools.some((t) => t.name === "browser_run_code")).toBe(false);
    const first = await client.callTool({
      name: "browser_navigate",
      arguments: { url: base + "/redirect" },
    });
    expect(first.isError).toBeFalsy();
    expect(JSON.stringify(first)).toContain("/catalog");
    const next = await client.callTool({
      name: "browser_navigate",
      arguments: { url: base + "/external" },
    });
    expect(next.isError).toBeFalsy();
    expect(JSON.stringify(next)).toContain("EXTERNAL REDIRECT");
    const blocked = await client.callTool({
      name: "browser_click",
      arguments: { element: "Do not click", ref: "e1" },
    });
    expect(blocked.isError).toBe(true);
    const back = await client.callTool({
      name: "browser_navigate",
      arguments: { url: base + "/catalog" },
    });
    expect(back.isError).toBeFalsy();
    const snapshot = await client.callTool({
      name: "browser_snapshot",
      arguments: {},
    });
    const backText = (snapshot.content as { type: string; text?: string }[])
      .map((item) => item.text ?? "")
      .join("\n");
    const ref = backText.match(
      /link "Open external tab" \[ref=([^\]]+)\]/,
    )?.[1];
    expect(ref, backText).toBeTruthy();
    const popup = await client.callTool({
      name: "browser_click",
      arguments: { element: "Open external tab", target: ref },
    });
    expect(popup.isError).toBeFalsy();
    expect(JSON.stringify(popup)).toContain("EXTERNAL REDIRECT");
    const events = (await readFile(join(dir, "evidence.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0].externalUrl).toBeUndefined();
    expect(events[1].externalUrl).toContain("localhost");
    expect(events[2].ok).toBe(false);
    expect(events[3].externalUrl).toBeUndefined();
    expect(events[5].externalUrls).toContain(
      `http://localhost:${(server.address() as { port: number }).port}/destination`,
    );
    await client.close();
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({
        id,
        url: base,
        status: "failed",
        error: "Prueba de diagnóstico",
        createdAt: new Date().toISOString(),
        evidence: [],
        logs: [],
      }),
    );
    expect((await (await request.get("/api/runs/" + id + "/service-map", {
      headers: { "X-Characterize": "1" },
    })).json()).state).toBe("disabled");
    const snapshotLoaded = page.waitForResponse(
      (r) => r.url().includes("/trace-viewer/snapshot/") && r.ok(),
    );
    const filmstripLoaded = page.waitForResponse(
      (r) => r.url().includes("/trace-viewer/file/screencast/") && r.ok(),
    );
    await page.goto("/diagnostico/" + id);
    await expect(page.getByText("Prueba de diagnóstico")).toBeVisible();
    await expect(page.getByTitle("Playwright Trace Viewer")).toBeVisible();
    await Promise.all([snapshotLoaded, filmstripLoaded]);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("service map captures real MCP traffic, action windows, tabs and request details", async ({ page, request }) => {
  test.setTimeout(90000);
  const id = randomUUID();
  const dir = join("/private/tmp/characterize-e2e-data/runs", id);
  await mkdir(dir, { recursive: true });
  const target = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/cart" ?
      '<html><head><title>Cart</title></head><body><h1>Cart</h1><script>fetch("/api/cart")</script></body></html>' :
      '<html><head><title>Orders</title></head><body><h1>Orders</h1><button onclick=\'fetch("/api/orders/123?token=sentinel-secret");setTimeout(()=>fetch("/api/orders/456"),1800)\'>Load order</button><a target="_blank" href="/cart">Open cart</a></body></html>');
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (target.address() as { port: number }).port;
  const config = join(dir, "bridge.json");
  const run: Run = {
    ...runInputSchema.parse({ url, provider: "codex", serviceMapEnabled: true, headed: false }),
    id, createdAt: new Date().toISOString(), status: "failed", phase: "Exploration incomplete",
    contextFiles: [], warnings: [], logs: [], evidence: [],
  };
  await writeFile(config, JSON.stringify({ origin: url, headed: false, maxCalls: 10, outputDir: dir,
    evidencePath: join(dir, "evidence.jsonl"), serviceMapEnabled: true }));
  const client = new Client({ name: "service-map-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve("server/mcp-proxy.mjs"), config], stderr: "pipe",
    }));
    const navigation = await client.callTool({ name: "browser_navigate", arguments: { url } });
    expect(navigation.isError).toBeFalsy();
    const initial = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const detail = JSON.stringify(initial.content);
    const button = detail.match(/button \\"Load order\\" \[ref=([^\]]+)\]/)?.[1];
    expect(button, detail).toBeTruthy();
    const click = await client.callTool({ name: "browser_click", arguments: { element: "Load order", target: button } });
    expect(click.isError).toBeFalsy();
    const discovery = { capabilityKey:"load-order",capability:"Load an order",given:"an order can be loaded",
      action:"request the order",observed:"the browser requests the selected order",
      evidenceIds:[2,3],screenEvidenceId:3 };
    expect((await client.callTool({name:"record_discovery",arguments:discovery})).isError).toBeFalsy();
    expect((await client.callTool({name:"record_discovery",arguments:{...discovery,evidenceIds:[999]}})).isError).toBe(true);
    const plan = await client.callTool({name:"get_discovery_plan",arguments:{}});
    expect(JSON.stringify(plan)).toContain("Open cart");
    expect(JSON.stringify(plan)).toContain("recordedRuleCount");
    // Let the delayed fetch occur between MCP calls.
    await new Promise(resolve => setTimeout(resolve, 2300));
    const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const popup = JSON.stringify(snapshot.content).match(/link \\"Open cart\\" \[ref=([^\]]+)\]/)?.[1];
    expect(popup).toBeTruthy();
    expect((await client.callTool({ name: "browser_click", arguments: { element: "Open cart", target: popup } })).isError).toBeFalsy();
    await client.close();
    for (let i = 0; i < 50; i++) {
      try { await readFile(join(dir, "service-map-trace.json")); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    run.evidence = (await readFile(join(dir, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as Evidence[];
    const map = await buildServiceMap(dir, run, run.evidence);
    expect(map.state, JSON.stringify(map.coverage)).toBe("ready");
    const operation = map.operations.find(o => o.path === "/api/orders/{id}")!;
    expect(operation).toBeTruthy();
    const orders = map.observations.filter(o => o.operationId === operation.id);
    expect(orders).toHaveLength(2);
    expect(orders[0].evidenceId).toBe(3);
    expect(orders[1].evidenceId).toBeUndefined();
    expect(orders[0].status).toBe(200);
    expect(orders[0].durationMs).toBeGreaterThanOrEqual(0);
    const cart = map.observations.find(o => map.operations.find(op => op.id === o.operationId)?.path === "/api/cart")!;
    expect(cart).toBeTruthy();
    expect(map.screens.find(s => s.id === cart.screenId)?.page).not.toBe(map.screens.find(s => s.id === orders[0].screenId)?.page);
    expect(JSON.stringify(map)).not.toContain("sentinel-secret");
    run.serviceMapState = map.state;
    await writeFile(join(dir, "service-map.json"), JSON.stringify(map));
    await writeFile(join(dir, "run.json"), JSON.stringify(run));
    const headers = { "X-Characterize": "1" };
    expect((await request.get("/api/runs/" + id + "/service-map")).status()).toBe(403);
    expect((await request.get("/api/runs/" + id + "/service-map", { headers: { ...headers, Origin: "https://evil.test" } })).status()).toBe(403);
    expect((await request.get("/api/runs/" + randomUUID() + "/service-map", { headers })).status()).toBe(404);
    expect((await (await request.get("/api/runs/" + id + "/service-map", { headers })).json()).state).toBe("ready");
    await page.route("**/api/accounts", route => route.fulfill({ json: [] }));
    await page.goto("/");
    await page.locator(".history-link").filter({ hasText: "127.0.0.1" }).first().click();
    await expect(page.getByRole("heading",{name:"Gherkin scenarios",exact:true})).toBeVisible();
    await expect(page.getByText("Observed rule",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"View application map",exact:true}).click();
    await expect(page.getByRole("heading", { name: "Application map", exact: true })).toBeVisible();
    await page.getByLabel("Map detail").selectOption("elements");
    await page.getByLabel("Find map entity").fill(url);
    await page.locator(".entity-browser").getByRole("button",{name:url,exact:true}).click();
    await page.locator(".application-inspector").getByRole("button",{name:"GET /api/orders/{id}",exact:true}).click();
    await expect(page.locator(".entity-description")).toContainText("2 requests");
    await page.locator(".graph-evidence").getByRole("button",{name:"#3 · "+id.slice(0,8),exact:true}).click();
    await expect(page.locator("#evidence-3")).toHaveAttribute("open", "");
    await page.getByRole("button",{name:"View application map",exact:true}).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/service-map-mobile.png", fullPage: true });
  } finally {
    await client.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
