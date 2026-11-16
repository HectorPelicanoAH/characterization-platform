import { test, expect } from "@playwright/test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../../shared/model";
import type { ApplicationMap } from "../../shared/application-map";

test("application map has its own tab, nested entities, shared components and evidence", async ({ page, request }) => {
  const id=randomUUID(),dir=join("/private/tmp/characterize-e2e-data/runs",id),url="https://graph-fixture.test";
  await mkdir(dir,{recursive:true});
  const detail=(path:string,body:string)=>"- Page URL: "+url+path+'\n### Snapshot\n- banner:\n  - navigation "Main":\n    - link "Catalog" [ref=c1]\n    - button "Search" [ref=s1]\n- main:\n'+body;
  const run:Run={
    ...runInputSchema.parse({url,provider:"codex"}),id,status:"completed",phase:"Complete",createdAt:new Date().toISOString(),
    evidence:[
      {id:1,tool:"browser_snapshot",ok:true,at:"",detail:detail("/es/es/cart",'  - form "Basket":\n    - button "Update quantity" [ref=u1]')},
      {id:2,tool:"browser_click",element:"Catalog",ok:true,at:"",detail:detail("/catalog",'  - region "Filters":\n    - checkbox "Available" [ref=a1]')},
    ],contextFiles:[],warnings:[],logs:[],
    report:{summary:"Catalog",decisions:[],gaps:["Signed-in permissions remain unobserved"],flows:[]},
  };
  try {
    await writeFile(join(dir,"run.json"),JSON.stringify(run));
    await page.route("**/api/accounts",route=>route.fulfill({json:[]}));
    await page.goto("/");
    await page.getByRole("button",{name:"Local library",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Screen decision map"})).toHaveCount(0);
    await expect(page.getByLabel("Application graph")).toHaveCount(0);
    await page.getByRole("button",{name:"Application map",exact:true}).click();
    await page.getByLabel("Map application").selectOption(url);
    await page.getByLabel("Map detail").selectOption("components");
    await expect(page.getByLabel("Application graph")).toBeVisible();
    const response=await request.get("/api/application-map?site="+encodeURIComponent(url),{headers:{"X-Characterize":"1"}});
    const graph:ApplicationMap=await response.json();
    const header=graph.nodes.find(node=>node.kind==="component"&&node.label==="Header")!;
    expect(header.shared).toBe(true);
    expect(header.screenIds).toHaveLength(2);
    await expect(page.locator('[data-id="'+header.id+'"]')).toHaveCount(1);
    await page.locator(".entity-browser").getByRole("button",{name:"Cart",exact:true}).click();
    await page.getByRole("button",{name:"Focus screen",exact:true}).click();
    await expect(page.getByLabel("Map detail")).toHaveValue("components");
    const basket=graph.nodes.find(node=>node.label==="Basket")!,quantity=graph.nodes.find(node=>node.label==="Update quantity")!;
    expect(quantity.parentId).toBe(basket.id);
    await page.locator(".application-inspector").getByRole("button",{name:"Basket",exact:true}).click();
    await page.getByRole("button",{name:"Focus component",exact:true}).click();
    await expect(page.getByLabel("Map detail")).toHaveValue("elements");
    await expect(page.locator('[data-id="'+quantity.id+'"]')).toBeVisible();
    await page.locator('[data-id="'+quantity.id+'"]').click();
    await expect(page.locator(".application-inspector h2")).toHaveText("Update quantity");
    await page.locator(".graph-evidence").getByRole("button").first().click();
    await expect(page.locator("#evidence-1")).toHaveAttribute("open","");
    await page.getByRole("button",{name:"View application map",exact:true}).click();
    await page.getByLabel("Map application").selectOption(url);
    await page.screenshot({path:"test-results/application-map-desktop.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByLabel("Application graph")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:"test-results/application-map-mobile.png",fullPage:true});
  } finally {
    await rm(dir,{recursive:true,force:true});
    await rm(join("/private/tmp/characterize-e2e-data/library",id+".feature"),{force:true});
  }
});
