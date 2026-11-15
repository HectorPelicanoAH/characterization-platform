import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("official MCP follows same-domain redirects and records external destinations before blocking further interaction", async ({
  page,
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
    expect(JSON.stringify(next)).toContain("CASO DE SALIDA DEL DOMINIO");
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
    expect(JSON.stringify(popup)).toContain("CASO DE SALIDA DEL DOMINIO");
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
