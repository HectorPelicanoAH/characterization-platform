import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../shared/model.ts";
import { recoverReport, type RecoverTests } from "../server/report-recovery.ts";
import { Store } from "../server/store.ts";
import { verifyEvidence } from "../server/agent.ts";
import { commandArgs, parseStructuredOutput } from "../server/agent.ts";
import { recoveredTestsSchema } from "../server/report-recovery.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { libraryEntry } from "../server/library.ts";
import { readDiscoveries } from "../server/discoveries.ts";

const code = "import {test,expect} from '@playwright/test';test('rule',async({page})=>{await page.goto('https://recover.test/');await expect(page.getByRole('heading',{name:'Catalog'})).toBeVisible();});";
async function fixture(dir: string, count: number) {
  const store = new Store(dir);
  const run: Run = { ...runInputSchema.parse({ url: "https://recover.test", provider: "copilot" }), id: randomUUID(), createdAt: new Date().toISOString(), status: "failed", phase: "Report interrupted", contextFiles: [], warnings: [], logs: [],
    evidence: [{ id: 1, tool: "browser_navigate", ok: true, at: "", detail: "- Page URL: https://recover.test/\n- Page Title: Catalog\n- heading \"Catalog\"" }] };
  store.saveRun(run);
  const discoveries = Array.from({ length: count }, (_, index) => ({ id: "rule-" + index, at: "", capabilityKey: "rule-" + index, capability: "Rule " + index,
    component: "Catalog", given: "the catalog is open", action: "view the catalog", observed: "the catalog heading is visible", scope: "observed", examples: [], evidenceIds: [1], screenEvidenceId: 1 }));
  await writeFile(join(store.runDir(run.id), "discoveries.jsonl"), discoveries.map(value => JSON.stringify(value)).join("\n"));
  return { store, run };
}
function requested(prompt: string) { return JSON.parse(prompt.slice(prompt.indexOf('\n{"startUrl"') + 1)).rules as { id: string }[]; }

test("report recovery checkpoints completed batches and resumes only missing rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-recovery-"));
  try {
    const { store, run } = await fixture(root, 17);
    const originalEvidence = JSON.stringify(run.evidence);
    let first = true;
    const generate: RecoverTests = async (_run, prompt) => {
      const rules = requested(prompt);
      if (rules[0].id === "rule-4" && first) throw Error("Provider interrupted");
      return { tests: rules.map(rule => ({ discoveryId: rule.id, testCode: code, limitation: "" })) };
    };
    await assert.rejects(recoverReport(store, run, new AbortController().signal, generate, () => {}), /Provider interrupted/);
    const checkpoint = JSON.parse(await readFile(join(store.runDir(run.id), "report-recovery", "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.tests.length, 4);
    first = false; const requestedAgain: string[] = [];
    const report = await recoverReport(store, run, new AbortController().signal, async (...args) => {
      requestedAgain.push(...requested(args[1]).map(rule => rule.id)); return generate(...args);
    }, () => {});
    assert.equal(requestedAgain.length, 13);
    assert.ok(!requestedAgain.includes("rule-0"));
    assert.equal(report.flows.length, 17);
    assert.equal(report.flows[0].given, "the catalog is open");
    assert.equal(JSON.stringify(run.evidence), originalEvidence);
    verifyEvidence(report, run.evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsupported tests become explicit gaps and incomplete model batches are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-recovery-gaps-"));
  try {
    const { store, run } = await fixture(root, 2);
    await assert.rejects(recoverReport(store, run, new AbortController().signal, async () => ({ tests: [{ discoveryId: "rule-0", testCode: code, limitation: "" }] }), () => {}), /exactly its saved rules/);
    const report = await recoverReport(store, run, new AbortController().signal, async () => ({ tests: [
      { discoveryId: "rule-0", testCode: code, limitation: "" },
      { discoveryId: "rule-1", testCode: null, limitation: "The prerequisite could not be reconstructed from captured evidence." },
    ] }), () => {});
    assert.equal(report.flows.length, 1);
    assert.match(report.gaps[0], /prerequisite could not be reconstructed/);
    assert.match(report.summary, /pending review and execution/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery can retrieve prerequisites from the saved recording without browser or write tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-evidence-"));
  const client = new Client({ name: "recovery-test", version: "1" });
  try {
    const evidence = join(root, "evidence.jsonl"), config = join(root, "recording.json");
    await writeFile(evidence, [
      { id: 1, tool: "browser_snapshot", ok: true, detail: '- button "Necessary cookies"' },
      { id: 2, tool: "browser_click", ok: false, detail: "failed click" },
    ].map(value => JSON.stringify(value)).join("\n"));
    await writeFile(config, JSON.stringify({ evidencePath: evidence }));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("server/report-evidence.mjs"), config], stderr: "pipe" }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["get_saved_evidence", "search_saved_evidence"]);
    const found = await client.callTool({ name: "search_saved_evidence", arguments: { query: "cookies" } });
    assert.match(JSON.stringify(found), /Necessary cookies/);
    const saved = await client.callTool({ name: "get_saved_evidence", arguments: { ids: [1] } });
    assert.ok(!saved.isError);
    assert.equal((await client.callTool({ name: "get_saved_evidence", arguments: { ids: [2] } })).isError, true);
    for (const provider of ["codex", "claude", "copilot"] as const) {
      const command = commandArgs(runInputSchema.parse({ url: "https://fixture.test", provider }), root, "Complete report", { browser: false, recording: config });
      assert.ok(command.args.some(value => value.includes("recording")));
      assert.ok(!command.args.some(value => value.includes("mcp-proxy.mjs")));
    }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("generated code retains literal newlines when the provider forgets to escape them in JSON", () => {
  const expected = { tests: [{ discoveryId: "rule-0", testCode: "import {test,expect} from '@playwright/test';\n// Generated code\n", limitation: "" }] };
  const raw = JSON.stringify(expected).replace("\\n", "\n");
  assert.deepEqual(parseStructuredOutput(raw, "copilot", recoveredTestsSchema), expected);
  assert.deepEqual(parseStructuredOutput("The recovered tests follow:\n```json\n" + raw + "\n```", "copilot", recoveredTestsSchema), expected);
  const interrupted = '{"tests":[{"discoveryId":"unfinished\n\n' + JSON.stringify(expected, null, 2);
  assert.deepEqual(parseStructuredOutput(interrupted, "copilot", recoveredTestsSchema), expected);
});

test("completing a saved report retains scenario IDs, observations and prior exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-library-identity-"));
  try {
    const { store, run } = await fixture(root, 1);
    run.discoveries = readDiscoveries(store.runDir(run.id), run.evidence);
    const before = libraryEntry(store, run).scenarios[0];
    run.reportRecovery = { startedAt: "", completedRules: 1, totalRules: 1 };
    run.report = await recoverReport(store, run, new AbortController().signal, async () => ({ tests: [{ discoveryId: "rule-0", testCode: code, limitation: "" }] }), () => {});
    const after = libraryEntry(store, run).scenarios[0];
    assert.equal(after.id, before.id);
    assert.equal(after.occurrences.length, 1);
    store.exclude(run.id, before.id);
    assert.equal(libraryEntry(store, run).scenarios.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
