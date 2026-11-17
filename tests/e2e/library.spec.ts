import { test, expect } from "@playwright/test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../../shared/model";
import type { LibraryEntry } from "../../server/library";

test("library groups repeated scenarios and removes all grouped copies", async ({ page, request }) => {
  const root = "/private/tmp/characterize-e2e-data";
  const ids = [randomUUID(),randomUUID()];
  try {
    for (const [index,id] of ids.entries()) {
      const dir = join(root,"runs",id);
      await mkdir(dir,{recursive:true});
      const flow = { title:"Apply catalog filter",given:"the catalog is open",steps:["Apply a filter"],observed:"The filter is active",evidenceIds:[1],
        testCode:"import {test,expect} from '@playwright/test';test('filter',async()=>{expect(true).toBe(true)});" };
      const run: Run = {
        ...runInputSchema.parse({url:"https://catalog-fixture.test",provider:"codex"}),
        id,createdAt:new Date(Date.now()+index).toISOString(),status:"completed",phase:"Complete",contextFiles:[],warnings:[],logs:[],
        evidence:[{id:1,at:new Date().toISOString(),ok:true,tool:"browser_snapshot",detail:"- Page URL: https://catalog-fixture.test/catalog\n- Page Title: Catalog"}],
        report:{summary:"Filter observed",decisions:[],gaps:[],flows:[flow,{...flow}, {...flow,title:"Empty filter result",observed:"The result is empty"}]},
      };
      await writeFile(join(dir,"run.json"),JSON.stringify(run));
    }
    await page.route("**/api/accounts",route=>route.fulfill({json:[]}));
    await page.goto("/");
    await page.getByRole("button",{name:"Local library",exact:true}).click();
    const scenario = page.locator(".flow-card").filter({has:page.locator("summary").filter({hasText:"Apply catalog filter"})});
    await expect(scenario).toHaveCount(1);
    await scenario.locator("summary").click();
    await expect(scenario.getByRole("button",{name:"View observation",exact:true})).toHaveCount(2);
    page.once("dialog",dialog=>dialog.accept());
    await scenario.getByRole("button",{name:"Delete scenario",exact:true}).click();
    await expect(scenario).toHaveCount(0);
    await expect(page.locator(".flow-card").filter({hasText:"Empty filter result"})).toHaveCount(1);
    await page.reload();
    await page.getByRole("button",{name:"Local library",exact:true}).click();
    await expect(page.locator(".flow-card").filter({hasText:"Apply catalog filter"})).toHaveCount(0);
    for (const id of ids) {
      const response = await request.get("/api/runs/"+id+"/scenarios",{headers:{"X-Characterize":"1"}});
      const entry = await response.json();
      expect(entry.scenarios).toHaveLength(1);
      expect(entry.feature).not.toContain("Scenario: Apply catalog filter");
    }
  } finally {
    for (const id of ids) {
      await rm(join(root,"runs",id),{recursive:true,force:true});
      await rm(join(root,"library",id+".feature"),{force:true});
    }
  }
});

test("AI refinement asks for clarification and confirms cross-scenario changes before saving", async ({ page, request }) => {
  const root = "/private/tmp/characterize-e2e-data", id = randomUUID();
  const dir = join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  const flow = { title: "Remove bag line", given: "the bag contains one line", steps: ["Use Eliminar"], observed: "Tu bolsa está vacía", evidenceIds: [1],
    testCode: "import {test,expect} from '@playwright/test';test('bag',async()=>{expect(true).toBe(true)});" };
  const run: Run = { ...runInputSchema.parse({ url: "https://refine-ui.test", provider: "copilot" }), id, createdAt: new Date().toISOString(), status: "completed", phase: "Complete", contextFiles: [], warnings: [], logs: [],
    evidence: [{ id: 1, at: new Date().toISOString(), ok: true, tool: "browser_navigate", detail: "- Page URL: https://refine-ui.test/bag\n- Page Title: Bag" }],
    report: { summary: "Bag observed", decisions: [], gaps: [], flows: [flow, { ...flow, title: "Remove one of two lines", given: "the bag contains two lines", observed: "The total is updated" }] } };
  try {
    await writeFile(join(dir, "run.json"), JSON.stringify(run));
    const entry: LibraryEntry = await (await request.get("/api/runs/" + id + "/scenarios", { headers: { "X-Characterize": "1" } })).json();
    const selected = entry.scenarios.find(scenario => scenario.title === flow.title)!;
    const sibling = entry.scenarios.find(scenario => scenario.title !== flow.title)!;
    let round = 0, saved = false, applied: string[] = [];
    const question = "Should the same vocabulary apply to the total scenario?";
    const after = "Scenario: Remove the last bag line\n  Given the bag contains one line\n  When the user removes that line\n  Then the bag is empty";
    const proposals = [
      { target: id + "/" + selected.id, title: "Remove the last bag line", reason: "Remove localized copy", before: selected.gherkin, after, selected: true, observations: 1 },
      { target: id + "/" + sibling.id, title: sibling.title, reason: "Align the shared vocabulary", before: sibling.gherkin, after: sibling.gherkin, selected: false, observations: 1 },
    ];
    await page.route("**/api/accounts", route => route.fulfill({ json: [] }));
    await page.route("**/api/library/*/*/refine", async route => {
      const body = route.request().postDataJSON();
      if (++round === 1) expect(body.comment).toContain("English");
      else { expect(body.comment).toContain("Yes, propose both"); expect(body.parentId).toBe("question-job"); }
      await route.fulfill({ status: 202, json: { id: round === 1 ? "question-job" : "ready-job", status: "running", summary: "", questions: [], changes: [] } });
    });
    await page.route("**/api/refinements/question-job", route => route.fulfill({ json: { id: "question-job", status: "questions", summary: "A shared rule may be affected", questions: [question], changes: [] } }));
    await page.route("**/api/refinements/ready-job", route => route.fulfill({ json: { id: "ready-job", status: "ready", summary: "Two scenarios may need the same change", questions: [], changes: proposals } }));
    await page.route("**/api/refinements/ready-job/apply", async route => {
      applied = route.request().postDataJSON().targets; saved = true;
      await route.fulfill({ json: { saved: applied.length } });
    });
    await page.route("**/api/library", async route => {
      const response = await route.fetch(); const entries: LibraryEntry[] = await response.json();
      if (saved) for (const item of entries.filter(item => item.id === id)) {
        item.scenarios = item.scenarios.map(scenario => scenario.id === selected.id ? { ...scenario, title: proposals[0].title, gherkin: after, state: "Refined · review tests" } : scenario);
        item.feature = item.feature.replace(selected.gherkin, after);
      }
      await route.fulfill({ json: entries });
    });
    await page.goto("/"); await page.getByRole("button", { name: "Local library", exact: true }).click();
    const card = page.locator(".flow-card").filter({ has: page.locator("summary").filter({ hasText: flow.title }) });
    await card.locator("summary").click();
    const linkColor = await card.getByRole("button", { name: "Refine with AI", exact: true }).evaluate(element => getComputedStyle(element).color);
    const textColor = await card.locator("pre").evaluate(element => getComputedStyle(element).color);
    expect(linkColor).not.toBe(textColor);
    await card.getByRole("button", { name: "Refine with AI", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Refine with AI" });
    await dialog.getByLabel("What would you like to improve?").fill("Use English and review related scenarios");
    await dialog.getByRole("button", { name: "Review with AI", exact: true }).click();
    await dialog.getByLabel(question).fill("Yes, propose both");
    expect(applied).toEqual([]);
    await dialog.getByRole("button", { name: "Review answers" }).click();
    await expect(dialog.getByText("Two scenarios may need the same change")).toBeVisible();
    const choices = dialog.getByRole("checkbox");
    await expect(choices.nth(0)).toBeChecked(); await expect(choices.nth(0)).toBeDisabled();
    await expect(choices.nth(1)).not.toBeChecked();
    await choices.nth(1).check(); await expect(dialog.getByRole("button", { name: "Save 2 scenarios" })).toBeVisible();
    await choices.nth(1).uncheck();
    expect(applied).toEqual([]);
    await page.screenshot({ path: "/private/tmp/characterize-refinement-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: "/private/tmp/characterize-refinement-mobile.png" });
    await dialog.getByRole("button", { name: "Save scenario", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(applied).toEqual([id + "/" + selected.id]);
    await expect(page.locator(".flow-card").filter({ hasText: "Remove the last bag line" })).toHaveCount(1);
    await expect(page.locator(".flow-card").filter({ hasText: sibling.title })).toHaveCount(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(join(root, "library", id + ".feature"), { force: true });
  }
});
