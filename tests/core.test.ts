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
import { Accounts, copilotSignInUrl } from "../server/providers.ts";

test("Copilot authorization requests account selection and preserves OAuth parameters", () => {
  const url = new URL(copilotSignInUrl("https://github.com/login/oauth/authorize?client_id=fixture&state=opaque-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback"));
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("state"), "opaque-state");
  assert.equal(url.searchParams.get("client_id"), "fixture");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1234/callback");
  assert.throws(() => copilotSignInUrl("https://example.com/login/oauth/authorize"));
  assert.throws(() => copilotSignInUrl("https://github.com/login"));
});

test("private account environments do not inherit global tokens in child processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "characterize-accounts-"));
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "fixture-global-token";
  try {
    const accounts = new Accounts(root);
    const env = accounts.environment("copilot");
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.COPILOT_HOME, join(root, "accounts", "copilot"));
    assert.equal(env.COPILOT_DISABLE_KEYTAR, "1");
    const result = await execute(process.execPath, ["-e", "process.stdout.write(String(process.env.GITHUB_TOKEN === undefined))"], { env });
    assert.equal(result.stdout.trim(), "true");
    assert.throws(() => accounts.answerLogin("copilot", "unrequested-choice"));
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

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

test("inactivity timeout terminates stalled workers and accepts browser and provider activity", async () => {
  await assert.rejects(execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeout: 2000, idleTimeout: 120,
  }), /without provider or browser activity/);
  let activity = Date.now();
  const heartbeat = setInterval(() => { activity = Date.now(); }, 30);
  try {
    const result = await execute(process.execPath, ["-e", "setTimeout(()=>process.exit(0),350)"], {
      timeout: 2000, idleTimeout: 150, activityAt: () => activity,
    });
    assert.equal(result.code, 0);
  } finally { clearInterval(heartbeat); }
  const result = await execute(process.execPath, ["-e",
    "const tick=setInterval(()=>console.log('progress'),40);setTimeout(()=>{clearInterval(tick);},2500)"], {
    timeout: 10000, idleTimeout: 2000,
  });
  assert.equal(result.code, 0);
});

test("exploration prompt prioritizes new paths and keeps rechecking as an explicit choice", async () => {
  const { agentPrompt } = await import("../server/agent.ts");
  const context = { files: [], warnings: [], characters: 0 };
  const settings = { context: "", directories: [] };
  assert.match(agentPrompt(input, settings, context), /Prioriza caminos nuevos/);
  assert.match(agentPrompt({ ...input, prioritizeNewPaths: false }, settings, context), /Vuelve a comprobar/);
});

test("library groups repeated observations while preserving different outcomes and sites", async () => {
  const { libraryEntry, consolidatedLibrary } = await import("../server/library.ts");
  const dir = await mkdtemp(join(tmpdir(), "characterize-dedup-"));
  try {
    const store = new Store(dir);
    const event = (id: number) => ({ id, tool: "browser_snapshot", ok: true, at: "", detail: "- Page URL: https://example.test/catalog\n- Page Title: Catalog" });
    const previous = { ...input, id: randomUUID(), createdAt: "2026-11-14", status: "completed", evidence: [event(1),event(2)],
      report: { ...structuredClone(report), flows: [structuredClone(report.flows[0]), { ...structuredClone(report.flows[0]), evidenceIds: [2] }] },
    } as Run;
    store.saveRun(previous);
    const first = libraryEntry(store,previous);
    assert.equal(first.scenarios.length,1);
    assert.equal(first.scenarios[0].occurrences.length,2);
    assert.deepEqual(first.scenarios[0].ids,[1,2]);
    const recent = { ...previous, id: randomUUID(), createdAt: "2026-11-15", report: {
      ...structuredClone(report), flows: [
        { ...structuredClone(report.flows[0]), title: "Same behavior renamed", evidenceIds: [2] },
        { ...structuredClone(report.flows[0]), observed: "The collection is empty" },
      ],
    } };
    store.saveRun(recent);
    const second = libraryEntry(store,recent);
    const grouped = consolidatedLibrary([first,second]);
    assert.equal(grouped.flatMap(entry=>entry.scenarios).length,2);
    assert.equal(grouped.flatMap(e=>e.scenarios).find(s=>s.fingerprint===first.scenarios[0].fingerprint)?.occurrences.length,3);
    assert.deepEqual(first.scenarios[0].ids,[1,2]);
    const third = { ...previous,id:randomUUID(),url:"https://other.test" };
    store.saveRun(third);
    assert.equal(consolidatedLibrary([first,second,libraryEntry(store,third)]).flatMap(e=>e.scenarios).length,3);
    const draft = { ...previous,id:randomUUID(),report:undefined,evidence:[event(1),event(2),{...event(3),detail:"- Page URL: https://example.test/cart\n- Page Title: Cart"},event(4)] };
    store.saveRun(draft);
    assert.equal(libraryEntry(store,draft).scenarios.length,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
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
