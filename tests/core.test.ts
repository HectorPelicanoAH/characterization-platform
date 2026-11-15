import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectContext } from "../server/context.ts";
import { runInputSchema, type Run, type Report } from "../shared/model.ts";
import { Store } from "../server/store.ts";
import { commandArgs, parseReport, verifyEvidence } from "../server/agent.ts";
import {
  sameDomain,
  pageUrlFromResult,
  externalUrlsFromResult,
} from "../server/domain.mjs";
import { execute } from "../server/process.ts";

const input = runInputSchema.parse({
  url: "https://shop.example.co.uk",
  provider: "codex",
});
const report: Report = {
  decisions: [],
  summary: "Filtro observado",
  flows: [
    {
      title: "Filtrar",
      given: "",
      steps: ["Abrir catálogo"],
      observed: "Se ven dos artículos",
      evidenceIds: [1],
      testCode:
        "import { test, expect } from '@playwright/test'; test('filter', async ({ page }) => { await expect(page.getByRole('heading')).toBeVisible(); });",
    },
  ],
  gaps: [],
};

test("scope is registrable domain, including subdomains, protocol and port; shared hosts stay separate", () => {
  assert.equal(
    sameDomain(
      "https://a.example.co.uk/one",
      "http://b.example.co.uk:8080/two",
    ),
    true,
  );
  assert.equal(
    sameDomain("https://example.co.uk", "https://another.co.uk"),
    false,
  );
  assert.equal(
    sameDomain("https://example.com", "https://example.com.evil.test"),
    false,
  );
  assert.equal(sameDomain("https://a.github.io", "https://b.github.io"), false);
  assert.equal(
    sameDomain("http://localhost:1234", "http://localhost:4567"),
    true,
  );
  assert.equal(sameDomain("http://127.0.0.1", "http://127.0.0.2"), false);
  assert.equal(sameDomain("https://example.com", "file:///etc/passwd"), false);
  assert.equal(
    pageUrlFromResult(
      "### Page\n- Page URL: https://external.test/foo\n- Page Title: X",
    ),
    "https://external.test/foo",
  );
  assert.deepEqual(
    externalUrlsFromResult(
      "### Open tabs\n- 0: (current) [App](https://app.example.com/)\n- 1: [Partner](https://external.test/path)\n### Page\n- Page URL: https://app.example.com/",
      "https://example.com",
    ),
    ["https://external.test/path"],
  );
});

test("context loads nested instructions and excludes symlinks, secrets, binaries, large files and dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-context-"));
  try {
    await mkdir(join(dir, ".agents"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, ".agents", "SKILL.md"), "Use roles");
    await writeFile(join(dir, "guardrails.yaml"), "avoid: purchase");
    await writeFile(join(dir, "secrets.md"), "do not read");
    await writeFile(join(dir, "node_modules", "README.md"), "do not read");
    await writeFile(join(dir, "large.md"), "x".repeat(25000));
    await writeFile(join(dir, "image.png"), "image");
    await symlink(join(dir, ".agents", "SKILL.md"), join(dir, "linked.md"));
    const snapshot = await collectContext([dir, dir]);
    assert.equal(snapshot.files.length, 2);
    assert.equal(snapshot.files[0].hash.length, 64);
    assert.ok(snapshot.warnings.some((w) => w.includes("large.md")));
    await assert.rejects(() => collectContext(["relative"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("URL validation rejects executable schemes and credentials", () => {
  for (const url of [
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "https://name:secret@example.com",
  ])
    assert.equal(runInputSchema.safeParse({ ...input, url }).success, false);
});

test("provider arguments keep prompts out of a shell and configure real Playwright MCP", () => {
  for (const provider of ["codex", "claude", "copilot"] as const) {
    const result = commandArgs(
      { ...input, provider, effort: "high", model: "custom-model" },
      "/tmp/space here",
      "prompt $(no-shell)",
    );
    assert.ok(result.args.join(" ").includes("mcp-proxy.mjs"));
    assert.ok(result.args.includes("custom-model"));
    assert.ok(
      !result.args.some((a) => a.includes("bypass") || a === "--allow-all"),
    );
    assert.ok(
      result.stdin === "prompt $(no-shell)" ||
        result.args.includes("prompt $(no-shell)"),
    );
  }
});

test("report parsing accepts native structured responses and rejects invalid or invented evidence", () => {
  assert.deepEqual(parseReport(JSON.stringify(report), "codex"), report);
  assert.deepEqual(
    parseReport(JSON.stringify({ structured_output: report }), "claude"),
    report,
  );
  assert.deepEqual(
    parseReport("```json\n" + JSON.stringify(report) + "\n```", "copilot"),
    report,
  );
  assert.throws(() => parseReport('{"summary":"missing fields"}', "codex"));
  assert.throws(() => verifyEvidence(report, []));
  assert.throws(() =>
    verifyEvidence(report, [
      { id: 1, tool: "browser_navigate", at: "", ok: false, detail: "" },
    ]),
  );
  verifyEvidence(report, [
    { id: 1, tool: "browser_navigate", at: "", ok: true, detail: "Observed" },
  ]);
  assert.throws(
    () =>
      verifyEvidence(report, [
        {
          id: 1,
          tool: "browser_navigate",
          at: "",
          ok: true,
          detail: "Observed",
        },
        {
          id: 2,
          tool: "browser_click",
          at: "",
          ok: true,
          detail: "External",
          externalUrl: "https://external.test/",
        },
      ]),
    /Missing observed/,
  );
});

test("persisted runs survive restart and running work is never falsely completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-store-"));
  try {
    const store = new Store(dir);
    const run: Run = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "running",
      phase: "",
      contextFiles: [],
      warnings: [],
      evidence: [],
      logs: [],
    };
    store.saveRun(run);
    store.saveSettings({ context: "remember", directories: [] });
    const restarted = new Store(dir);
    assert.equal(restarted.run(run.id)?.status, "interrupted");
    assert.equal(restarted.settings().context, "remember");
    assert.throws(() => store.run("../../etc/passwd"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker cancellation and timeout terminate actual child processes", async () => {
  const abort = new AbortController();
  const pending = execute(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: abort.signal },
  );
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /Cancelled/);
  await assert.rejects(
    execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    /timed out/,
  );
});

test("maps preserve alternative outcomes and ignore failed or missing evidence", async () => {
  const { decisionMaps } = await import("../server/decision-map.ts");
  const event = (id:number, path:string, ok=true) => ({
    id,at:"",ok,tool:id===1?"browser_navigate":"browser_click",detail:"- Page URL: https://example.test/"+path,
  });
  const run = {id:"run",url:"https://example.test",evidence:[event(1,"cart"),event(2,"cart"),event(3,"checkout"),event(4,"unseen",false)],
    report:{...report, decisions:[
      {sourceEvidenceId:1,resultEvidenceId:2,condition:"Cart empty",action:"Continue",outcome:"Validation shown"},
      {sourceEvidenceId:2,resultEvidenceId:3,condition:"Cart has items",action:"Continue",outcome:"Checkout opens"},
      {sourceEvidenceId:3,resultEvidenceId:4,condition:"Unknown",action:"Pay",outcome:"Unverified"},
    ]}} as Run;
  const [map] = decisionMaps([run,run]);
  assert.equal(map.screens.length,2);
  assert.deepEqual(map.branches.map(b=>b.condition),["Cart empty","Cart has items"]);
});

test("library renders screen context and preserves scenario exclusions when wording changes", async () => {
  const {libraryEntry} = await import("../server/library.ts");
  const dir = await mkdtemp(join(tmpdir(), "characterize-gherkin-"));
  try {
    const store = new Store(dir);
    const run = {...input,id:randomUUID(),report:structuredClone(report),evidence:[
      {id:1,tool:"browser_snapshot",ok:true,at:"",detail:"- Page URL: https://example.test/catalog\n- Page Title: Catalog"},
    ]} as Run;
    store.saveRun(run);
    const original = libraryEntry(store,run).scenarios[0];
    assert.match(original.gherkin,/Given the user is on the Catalog screen/);
    run.report!.flows[0].given = "the catalog offers a choice of colors";
    assert.match(libraryEntry(store,run).feature,/Given the catalog offers a choice of colors/);
    store.exclude(run.id,original.id);
    assert.equal(libraryEntry(store,run).scenarios.length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
