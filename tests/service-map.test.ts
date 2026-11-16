import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildServiceMap, normalizedUrl } from "../server/service-map.ts";
import { Store } from "../server/store.ts";
import { Runs } from "../server/runs.ts";
import { Accounts } from "../server/providers.ts";
import { runInputSchema, type Run, type Evidence } from "../shared/model.ts";

const epoch = Date.parse("2026-11-15T10:00:00Z");
const iso = (ms: number) => new Date(epoch + ms).toISOString();
const run: Run = {
  ...runInputSchema.parse({ url: "https://shop.test", provider: "codex", serviceMapEnabled: true }),
  id: randomUUID(), createdAt: iso(0), status: "completed", phase: "", evidence: [], logs: [], warnings: [], contextFiles: [],
};
const header = { type: "context-options", version: 10, wallTime: epoch, monotonicTime: 0 };
const snapshot = (time: number, pageId = "page1", frameUrl = "https://shop.test/orders/123") => ({
  type: "frame-snapshot", snapshot: { pageId, frameUrl, timestamp: time, isMainFrame: true },
});

test("normal run finalization publishes the map independently of report generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "service-map-lifecycle-"));
  const previousPath = process.env.PATH;
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const report = {
      summary: "Observed page", decisions: [], gaps: [],
      flows: [{ title: "Open page", given: "", steps: ["Open page"], observed: "Page visible", evidenceIds: [1], testCode: "import { test, expect } from '@playwright/test'; test('page', async ({ page }) => { await expect(page.getByRole('heading')).toBeVisible(); });" }],
    };
    const script = [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      'const config = JSON.parse(fs.readFileSync("bridge.json", "utf8"));',
      'if (!config.serviceMapEnabled) process.exit(1);',
      'fs.mkdirSync("traces");',
      'fs.writeFileSync("traces/trace-1.trace", ' + JSON.stringify(JSON.stringify(header) + "\n") + ');',
      'fs.writeFileSync("traces/trace-1.network", ' + JSON.stringify(JSON.stringify(request(150, "https://shop.test/orders/1")) + "\n") + ');',
      'fs.writeFileSync("service-map-trace.json", \'{"closed":true}\');',
      'fs.writeFileSync("evidence.jsonl", ' + JSON.stringify(JSON.stringify({ id: 1, tool: "browser_navigate", at: iso(0), ok: true, detail: "- Page URL: https://shop.test/" }) + "\n") + ');',
      'fs.writeFileSync("response.json", ' + JSON.stringify(JSON.stringify(report)) + ');',
    ].join("\n");
    await writeFile(join(bin, "codex"), script);
    await chmod(join(bin, "codex"), 0o700);
    process.env.PATH = bin + ":" + previousPath;
    const store = new Store(join(dir, "store"));
    const accounts = new Accounts(store.root);
    accounts.status = async id => ({ id, connected: true, installed: true });
    const manager = new Runs(store, accounts);
    const running = await manager.start(runInputSchema.parse({ url: run.url, provider: "codex", serviceMapEnabled: true }));
    for (let i = 0; i < 1000 && manager.serviceMap(running.id)?.state === "pending"; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.run(running.id)?.status, "completed", JSON.stringify(manager.get(running.id)));
    assert.equal(manager.serviceMap(running.id)?.state, "ready");
    assert.equal(manager.serviceMap(running.id)?.observations.length, 1);
    assert.equal(store.run(running.id)?.report?.summary, report.summary);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
const request = (time: number, url: string, options: Record<string, unknown> = {}) => ({
  type: "resource-snapshot", snapshot: {
    pageref: "page1", startedDateTime: iso(time), _monotonicTime: time, _resourceType: "fetch",
    request: { method: "GET", url, headers: [{ name: "Authorization", value: "sentinel-secret" }], postData: { text: "sentinel-secret" } },
    response: { status: 200 }, time: 42, ...options,
  },
});
const evidence: Evidence[] = [{ id: 12, tool: "browser_click", at: iso(300), ok: true, detail: "", startedAt: iso(100), finishedAt: iso(300) }];
async function fixture(dir: string, network: unknown[], trace: unknown[] = [header, snapshot(110), snapshot(290)]) {
  await mkdir(join(dir, "traces"), { recursive: true });
  await writeFile(join(dir, "traces/trace-1.trace"), trace.map(e => JSON.stringify(e) + "\n").join(""));
  await writeFile(join(dir, "traces/trace-1.network"), network.map(e => JSON.stringify(e) + "\n").join(""));
  await writeFile(join(dir, "service-map-trace.json"), '{"closed":true}');
}

test("network inventory groups operations, preserves ports, attributes pages and projects only safe fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "service-map-"));
  try {
    await fixture(dir, [
      request(150, "https://shop.test/orders/123?token=sentinel-secret"),
      request(200, "https://shop.test/orders/456#sentinel-secret"),
      request(350, "https://shop.test/orders/789"),
      request(160, "https://shop.test:8443/orders/123", { response: { status: 302 } }),
      request(170, "https://partner.test/collect", { pageref: "page2", response: { status: 404 } }),
      request(180, "https://shop.test/token/sentinel-secret", { response: { status: -1, _failureText: "sentinel-secret" }, time: -1 }),
      request(210, "https://shop.test/static/a.js", { _resourceType: "script" }),
      request(220, "https://shop.test/graphql", { request: { method: "POST", url: "https://shop.test/graphql", postData: { text: "sentinel-secret" } } }),
      request(230, "https://shop.test/", { _resourceType: "document" }),
    ], [header, snapshot(110), snapshot(290), snapshot(400, "page2", "https://shop.test/cart")]);
    const map = await buildServiceMap(dir, run, evidence);
    assert.equal(map.state, "ready");
    assert.equal(map.observations.length, 8);
    assert.equal(map.services.length, 3);
    assert.equal(map.coverage.excludedType, 1);
    const orders = map.operations.find(o => o.path === "/orders/{id}" && map.services.find(s => s.id === o.serviceId)?.origin === "https://shop.test")!;
    assert.equal(map.observations.filter(o => o.operationId === orders.id).length, 3);
    assert.equal(map.observations[0].evidenceId, 12);
    assert.equal(map.observations[2].evidenceId, undefined);
    assert.equal(map.observations[4].evidenceId, undefined);
    assert.notEqual(map.observations[0].screenId, map.observations[4].screenId);
    assert.equal(map.observations[4].status, 404);
    assert.equal(map.observations[5].failed, true);
    assert.equal(map.observations[5].durationMs, null);
    assert.ok(!JSON.stringify(map).includes("sentinel-secret"));
    assert.deepEqual(await buildServiceMap(dir, run, evidence), map);
    assert.equal(normalizedUrl("https://shop.test/api/v1/Orders/123?secret=x")?.pathname, "/api/v1/Orders/%7Bid%7D");
    // Multiple pages observed during one MCP window make its attribution ambiguous.
    await fixture(dir, [request(150, "https://shop.test/orders/1")], [header, snapshot(110), snapshot(120, "page2")]);
    assert.equal((await buildServiceMap(dir, run, evidence)).observations[0].evidenceId, undefined);
    // A changed SPA route between observations has an unknown start time.
    await fixture(dir, [request(150, "https://shop.test/orders/1")], [header, snapshot(110), snapshot(290, "page1", "https://shop.test/cart")]);
    const changed = await buildServiceMap(dir, run, evidence);
    assert.equal(changed.screens[0].label, "Unidentified screen");
    await fixture(dir, [request(150, "https://shop.test/orders/1", { _monotonicTime: 1500 })]);
    assert.equal((await buildServiceMap(dir, run, evidence)).observations[0].evidenceId, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("empty, interrupted, incompatible and bounded traces have explicit coverage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "service-map-"));
  try {
    assert.equal((await buildServiceMap(dir, run, [])).state, "unavailable");
    await fixture(dir, []);
    assert.equal((await buildServiceMap(dir, run, [])).state, "ready");
    const requests = Array.from({ length: 11000 }, (_, i) => request(150 + i, "https://shop.test/orders/" + i));
    await fixture(dir, requests);
    const limited = await buildServiceMap(dir, run, []);
    assert.equal(limited.observations.length, 10000);
    assert.equal(limited.state, "partial");
    assert.ok(limited.coverage.reasons.includes("observation-limit"));
    const bytes = await buildServiceMap(dir, run, [], { bytes: 4096 });
    assert.equal(bytes.coverage.bytesRead, 4096);
    assert.ok(bytes.coverage.reasons.includes("byte-limit"));
    await fixture(dir, [request(150, "https://shop.test/orders/1")]);
    await writeFile(join(dir, "traces/trace-1.network"),
      JSON.stringify(request(150, "https://shop.test/orders/1")) + "\n" + "x".repeat(3000) + "\n" + '{"type":');
    const partial = await buildServiceMap(dir, { ...run, status: "cancelled" }, [], { lineBytes: 1024 });
    assert.equal(partial.observations.length, 1);
    assert.equal(partial.state, "partial");
    assert.ok(partial.coverage.reasons.includes("capture-interrupted"));
    assert.ok(partial.coverage.reasons.includes("truncated-line"));
    assert.ok(partial.coverage.reasons.includes("line-limit"));
    await fixture(dir, [], [{ ...header, version: 999 }]);
    assert.equal((await buildServiceMap(dir, run, [])).state, "unavailable");
    await rm(join(dir, "traces/trace-1.trace"));
    await symlink("/etc/passwd", join(dir, "traces/trace-1.trace"));
    assert.equal((await buildServiceMap(dir, run, [])).state, "unavailable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("restart rebuilds enabled unfinished maps while preserving the report and old histories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "service-map-store-"));
  try {
    const store = new Store(dir);
    store.saveRun({ ...run, status: "running", serviceMapState: "pending" });
    await fixture(store.runDir(run.id), [request(150, "https://shop.test/orders/1")]);
    const oldId = randomUUID();
    const old = { ...run, id: oldId } as Partial<Run>;
    delete old.serviceMapEnabled;
    store.saveRun(old as Run);
    const restarted = new Store(dir);
    const manager = new Runs(restarted, new Accounts(dir));
    assert.equal(manager.serviceMap(oldId)?.state, "disabled");
    assert.equal(manager.serviceMap(randomUUID()), undefined);
    assert.equal(manager.serviceMap(run.id)?.state, "pending");
    for (let i = 0; i < 100 && manager.serviceMap(run.id)?.state === "pending"; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.serviceMap(run.id)?.state, "partial");
    assert.equal(restarted.run(run.id)?.status, "interrupted");
    const persisted = JSON.parse(await readFile(join(store.runDir(run.id), "service-map.json"), "utf8"));
    assert.equal(persisted.observations.length, 1);
    // A completed report remains available when the trace format is unreadable.
    const complete = { ...run, id: randomUUID(), report: { summary: "Saved report", flows: [], gaps: [], decisions: [] } };
    store.saveRun(complete);
    await fixture(store.runDir(complete.id), [], [{ ...header, version: 999 }]);
    const recovering = new Runs(new Store(dir), new Accounts(dir));
    for (let i = 0; i < 100 && recovering.serviceMap(complete.id)?.state === "pending"; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(recovering.serviceMap(complete.id)?.state, "unavailable");
    assert.equal(store.run(complete.id)?.report?.summary, "Saved report");
    assert.equal(store.run(complete.id)?.status, "completed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
