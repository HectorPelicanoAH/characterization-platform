import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../shared/model.ts";
import { renderScenario } from "../shared/scenario.ts";
import { assertScenarioNames, renameGherkin, saveScenarioNames, scenarioNameKey } from "../server/scenario-names.ts";
import { libraryEntry, namedReport } from "../server/library.ts";
import { Store } from "../server/store.ts";

const origin = "https://names.test";
const gherkin = (action: string, outcome: string) => renderScenario({ title: "Bag quantity", given: ["the bag contains an available variant"], when: [action], then: [outcome], parameters: null });
const catalog = [
  { title: "Bag quantity", gherkin: gherkin("increase its quantity", "the total increases") },
  { title: "Bag quantity", gherkin: gherkin("decrease its quantity", "the total decreases") },
].map(scenario => ({ ...scenario, key: scenarioNameKey(origin, scenario.gherkin) }));

test("different behaviors cannot share a title and conflicting old names can be renamed together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenario-names-")), path = join(dir, "names.json");
  try {
    assert.throws(() => assertScenarioNames(catalog, new Set(catalog.map(scenario => scenario.key))), /different behavior/);
    const changes = [
      { key: catalog[0].key, title: "Increase bag quantity and recalculate totals" },
      { key: catalog[1].key, title: "Decrease bag quantity and recalculate totals" },
    ];
    const renamed = saveScenarioNames(path, catalog, changes);
    assert.equal(renamed[0].title, changes[0].title);
    const original = await readFile(path, "utf8");
    assert.throws(() => saveScenarioNames(path, catalog, [{ key: catalog[1].key, title: " INCREASE bag quantity and recalculate totals. " }]), /different behavior/);
    assert.equal(await readFile(path, "utf8"), original, "An invalid rename cannot partially change the catalog");
    assert.throws(() => saveScenarioNames(path, catalog, [{ key: "0".repeat(64), title: "Unknown scenario" }]), /known scenarios/);
    assert.equal(scenarioNameKey(origin, renameGherkin(catalog[0].gherkin, "Different title")), catalog[0].key);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("title corrections update library, Gherkin and exported reports without changing IDs, assertions or evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenario-name-library-"));
  try {
    const store = new Store(dir);
    const code = "import {test,expect} from '@playwright/test';test('quantity',async({page})=>{await expect(page.getByRole('heading')).toBeVisible()});";
    const run: Run = { ...runInputSchema.parse({ url: origin, provider: "codex" }), id: randomUUID(), status: "completed", phase: "Complete", createdAt: new Date().toISOString(), logs: [], warnings: [], contextFiles: [],
      evidence: [{ id: 1, tool: "browser_snapshot", at: "", ok: true, detail: "- Page URL: https://names.test/cart\n- Page Title: Cart" }],
      report: { summary: "Quantity observed", decisions: [], gaps: [], flows: [
        { title: "Bag quantity", given: "the bag contains an available variant", steps: ["increase its quantity"], observed: "the total increases", evidenceIds: [1], testCode: code },
        { title: "Bag quantity", given: "the bag contains an available variant", steps: ["decrease its quantity"], observed: "the total decreases", evidenceIds: [1], testCode: code },
      ] } };
    store.saveRun(run);
    const before = libraryEntry(store, run);
    const titles = new Map(catalog.map((scenario, index) => [scenario.key, index ? "Decrease bag quantity and recalculate totals" : "Increase bag quantity and recalculate totals"]));
    saveScenarioNames(join(dir, "scenario-names.json"), before.scenarios.map(scenario => ({ key: scenario.nameKey, title: scenario.title, gherkin: scenario.gherkin })), before.scenarios.map(scenario => ({ key: scenario.nameKey, title: titles.get(scenario.nameKey)! })));
    const after = libraryEntry(store, run);
    assert.deepEqual(after.scenarios.map(scenario => scenario.id).sort(), before.scenarios.map(scenario => scenario.id).sort());
    assert.equal(new Set(after.scenarios.map(scenario => scenario.title)).size, 2);
    assert.ok(after.scenarios.every(scenario => scenario.state === "Documented" && scenario.occurrences.length === 1));
    assert.match(after.feature, /Scenario: Increase bag quantity and recalculate totals/);
    assert.equal(namedReport(store, run)!.flows[0].title, "Increase bag quantity and recalculate totals");
    assert.equal(namedReport(store, run)!.flows[0].testCode, code);
    assert.equal(store.run(run.id)!.report!.flows[0].title, "Bag quantity");
    store.exclude(run.id, before.scenarios[0].id);
    assert.equal(libraryEntry(store, run).scenarios.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
