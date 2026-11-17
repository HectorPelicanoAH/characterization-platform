import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { runInputSchema, type Run } from "../shared/model.ts";
import { scenarioTextSchema, renderScenario, type ScenarioText } from "../shared/scenario.ts";
import { parseReport, commandArgs, jsonSchema } from "../server/agent.ts";
import { auditExploration } from "../server/exploration.ts";
import { libraryEntry, consolidatedLibrary } from "../server/library.ts";
import { Store } from "../server/store.ts";
import { Refinements } from "../server/refinements.ts";

const bag: ScenarioText = { title: "Remove the last bag line", given: ["the bag contains one line"], when: ["the user removes that line"], then: ["the bag is empty"], parameters: null };
const related: ScenarioText = { title: "Update the bag total", given: ["the bag contains two lines"], when: ["the user removes one line"], then: ["the total reflects the remaining line"], parameters: null };
function fixture(index = 0, url = "https://refinement.test"): Run {
  return { ...runInputSchema.parse({ url, provider: "copilot" }), id: randomUUID(), status: "completed", phase: "Complete", createdAt: new Date(1700000000000 + index).toISOString(),
    logs: [], contextFiles: [], warnings: [], evidence: [{ id: 1, tool: "browser_navigate", at: "", ok: true, detail: `- Page URL: ${url}/bag\n- Page Title: Bag` }],
    report: { summary: "Observed bag behavior", decisions: [], gaps: [], flows: [
      { title: "Bag line removal and empty state", given: "Bag with a single line", steps: ["Remove it with Eliminar"], observed: "Tu bolsa está vacía and recommendations appear", evidenceIds: [1], testCode: "import {test,expect} from '@playwright/test'; test('remove',async({page})=>{await expect(page.getByRole('heading')).toBeVisible()})" },
      { title: "Remove another line", given: "Bag with two lines", steps: ["Remove a line"], observed: "The total is updated", evidenceIds: [1], testCode: "import {test,expect} from '@playwright/test'; test('total',async({page})=>{await expect(page.getByRole('heading')).toBeVisible()})" },
    ] },
  };
}

test("Copilot report parsing accepts a prose preamble and braces inside test strings while keeping schema validation", () => {
  const report = fixture().report!;
  assert.deepEqual(parseReport('Start with the observed behavior.\n```json\n' + JSON.stringify(report) + '\n```\nDone.', "copilot"), report);
  assert.throws(() => parseReport('Start with {"summary":"incomplete"}', "copilot"), /valid structured output/);
  const flowSchema = (jsonSchema as any).properties.flows.items;
  assert.deepEqual(new Set(flowSchema.required), new Set(Object.keys(flowSchema.properties)), "Structured output fields must all be required; absent parameters use null");
  for (const provider of ["codex", "claude", "copilot"] as const) {
    const command = commandArgs({ ...fixture(), provider }, "/private/tmp/refinement", "Refine without browser", { browser: false });
    assert.ok(!command.args.some(arg => arg.includes("mcp_servers.playwright")));
    assert.ok(!command.args.some(arg => arg.includes("mcp-proxy.mjs")));
    assert.ok(!command.args.includes("--allow-tool"));
  }
});

test("scenario outlines require complete observed example tables and reject injected clauses", () => {
  const outline: ScenarioText = { ...bag, given: ["the bag contains <line_count> lines"], parameters: { columns: ["line_count"], rows: [["1"]] } };
  assert.match(renderScenario(outline), /^Scenario Outline:/);
  assert.match(renderScenario(outline), /Examples:\n    \| line_count \|\n    \| 1 \|/);
  assert.throws(() => renderScenario({ ...outline, parameters: null }), /Examples/);
  assert.throws(() => renderScenario({ ...outline, parameters: { columns: ["line_count"], rows: [[]] } }), /Examples/);
  assert.throws(() => scenarioTextSchema.parse({ ...bag, then: ["the bag is empty\nScenario: injected"] }));
});

test("refinement asks questions, previews cross-scenario impact and persists only confirmed scenarios and grouped observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-refine-"));
  try {
    const store = new Store(dir), older = fixture(), newer = fixture(1), outside = fixture(2, "https://other.test");
    [older, newer, outside].forEach(run => store.saveRun(run));
    const originals = JSON.stringify(store.runs());
    const canonical = consolidatedLibrary([libraryEntry(store, older), libraryEntry(store, newer)])[0];
    const selected = canonical.scenarios.find(scenario => scenario.title.includes("empty state"))!;
    const sibling = canonical.scenarios.find(scenario => scenario.title === "Remove another line")!;
    const target = canonical.id + "/" + selected.id, other = canonical.id + "/" + sibling.id;
    let calls = 0;
    const service = new Refinements(store, id => store.run(id), async (_run, prompt) => {
      calls++;
      assert.ok(!prompt.includes("https://other.test"));
      if (calls === 1) return { summary: "Clarify the scope", questions: ["Should the total scenario use the same wording?"], changes: [] };
      assert.match(prompt, /Yes, propose both/);
      return { summary: "Two scenarios share this vocabulary", questions: [], changes: [
        { target, reason: "Remove localized UI copy", scenario: bag }, { target: other, reason: "Use the same business vocabulary", scenario: related },
      ] };
    });
    const first = service.start(canonical.id, selected.id, "Improve this and check related tests");
    assert.throws(() => service.apply(first.id, [target]), /new proposal/);
    await setImmediate();
    assert.equal(service.get(first.id)?.status, "questions");
    const next = service.start(canonical.id, selected.id, "Yes, propose both", first.id);
    await setImmediate();
    assert.equal(next.status, "ready");
    assert.equal(next.changes.length, 2);
    assert.equal(next.changes[0].observations, 2);
    assert.equal(next.changes[1].selected, false);
    assert.throws(() => service.apply(next.id, [other]), /selected scenario/);
    assert.deepEqual(service.apply(next.id, [target]), { saved: 1 });
    assert.equal(JSON.stringify(store.runs()), originals, "Original reports and evidence remain intact");
    assert.equal(Object.keys(store.refinements()).length, 2);
    assert.throws(() => service.apply(next.id, [target]), /new proposal/);
    const restarted = new Store(dir);
    for (const run of [older, newer]) {
      const entry = libraryEntry(restarted, restarted.run(run.id)!);
      const refined = entry.scenarios.find(scenario => scenario.id === selected.id)!;
      assert.equal(refined.title, bag.title);
      assert.equal(refined.gherkin, renderScenario(bag));
      assert.match(entry.feature, /Scenario: Remove the last bag line/);
      assert.ok(entry.scenarios.some(scenario => scenario.title === "Remove another line"));
      restarted.exclude(run.id, refined.id);
      assert.ok(!libraryEntry(restarted, run).feature.includes(bag.title));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stale multi-scenario proposal saves no partial changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-stale-refine-"));
  try {
    const store = new Store(dir), run = fixture(); store.saveRun(run);
    const entry = libraryEntry(store, run), first = entry.scenarios[0], second = entry.scenarios[1];
    const target = run.id + "/" + first.id, other = run.id + "/" + second.id;
    const service = new Refinements(store, id => store.run(id), async () => ({ summary: "Update both", questions: [], changes: [
      { target, reason: "Clear business language", scenario: bag }, { target: other, reason: "Shared rule", scenario: related },
    ] }));
    const job = service.start(run.id, first.id, "Update both"); await setImmediate();
    store.exclude(run.id, second.id);
    assert.throws(() => service.apply(job.id, [target, other]), /changed or was deleted/);
    assert.deepEqual(store.refinements(), {});
    assert.throws(() => service.apply(job.id, [target, "unknown"]), /only scenarios/);
    assert.deepEqual(store.refinements(), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("early provider closure adds measured coverage gaps instead of implying exhausted coverage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-closure-"));
  try {
    await writeFile(join(dir, "exploration-progress.json"), JSON.stringify({ usedCalls: 241, maxCalls: 280, screens: [{ screen: "Bag", route: "/bag", pendingCount: 3, blocked: 1 }] }));
    const report = fixture().report!; auditExploration(dir, report);
    assert.ok(report.gaps.some(gap => gap.includes("241/280") && gap.includes("without confirming")));
    assert.ok(report.gaps.some(gap => gap.includes("3 controls not exercised")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
