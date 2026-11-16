import { test, expect } from "@playwright/test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../../shared/model";

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
