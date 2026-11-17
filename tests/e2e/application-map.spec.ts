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
    await page.getByLabel("Find map entity").fill("Cart");
    await page.locator(".entity-browser").getByRole("button",{name:"Cart",exact:true}).click();
    await page.getByRole("button",{name:"Focus screen",exact:true}).click();
    await expect(page.getByLabel("Map detail")).toHaveValue("components");
    const basket=graph.nodes.find(node=>node.label==="Basket")!,quantity=graph.nodes.find(node=>node.label==="Update quantity")!;
    expect(quantity.parentId).toBe(basket.id);
    await page.locator(".application-inspector summary").filter({hasText:"Components"}).click();
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

test("overview includes the whole map and selection preserves its layout and zoom", async ({ page }) => {
  const nodes = ["Home", "Product", "Cart", "Search", "Other"].map(label => ({ id: label, kind: "screen" as const, label, shared: false, screenIds: [label], status: "observed" as const, evidence: [] }));
  const relation = (id: string, source: string, target: string) => ({ id, source, target, contextScreenId: source, kind: "navigates" as const, label: "Navigates", evidence: [], count: 1 });
  const map: ApplicationMap = { site: "https://overview.test", nodes: [...nodes,
    { id: "options", kind: "component", label: "Product options", parentId: "Product", shared: false, screenIds: ["Product"], status: "observed", evidence: [] },
    { id: "size", kind: "element", label: "Choose a size", parentId: "options", shared: false, screenIds: ["Product"], status: "observed", evidence: [] },
    { id: "rule", kind: "rule", label: "Require a size", parentId: "options", shared: false, screenIds: ["Product"], status: "observed", evidence: [] },
    { id: "api", kind: "service", label: "api.example.test", shared: false, screenIds: ["Product"], status: "observed", evidence: [] },
    { id: "operation", kind: "operation", label: "GET /products", parentId: "api", shared: false, screenIds: ["Product"], status: "observed", evidence: [] },
  ], edges: [relation("a", "Home", "Product"), relation("b", "Product", "Cart"), relation("c", "Cart", "Product"), relation("d", "Search", "Product"), relation("e", "Search", "Other"),
    { ...relation("call", "size", "operation"), kind: "calls", contextScreenId: "Product", label: "Calls" },
    { ...relation("contains", "Product", "options"), kind: "contains", label: "Contains" },
  ], pending: [], gaps: [], warnings: [], runIds: [] };
  await page.route("**/api/accounts", route => route.fulfill({ json: [] }));
  await page.route("**/api/application-map/sites", route => route.fulfill({ json: [map.site] }));
  await page.route("**/api/application-map?*", route => route.fulfill({ json: map }));
  await page.goto("/");
  await page.getByRole("button", { name: "Application map", exact: true }).click();
  await expect(page.getByLabel("Map screen", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Map detail")).toHaveValue("elements");
  await expect(page.getByRole("checkbox", { name: "Services", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Rules", exact: true })).toBeChecked();
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await expect(page.getByLabel("Map overview")).toBeVisible();
  await page.getByRole("button", { name: "Fit map", exact: true }).click();
  await page.waitForTimeout(250);
  const before = await page.locator(".react-flow__viewport").getAttribute("style");
  const positions = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-id"), (node as HTMLElement).style.transform]));
  const cart = page.locator('.react-flow__node[data-id="Cart"]');
  await cart.focus(); await cart.press("Enter");
  await expect(page.locator(".application-inspector h2")).toHaveText("Cart");
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(before);
  expect(await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-id"), (node as HTMLElement).style.transform]))).toEqual(positions);
  const edge = page.locator(".react-flow__edge").first();
  await edge.focus(); await edge.press("Enter");
  await expect(page.locator(".application-inspector h2")).toHaveText("Connection");
  await expect(page.locator('.react-flow__node[data-id="Cart"]')).toBeVisible();
  await page.getByLabel("Map screen", { exact: true }).selectOption("Product");
  await expect(page.locator(".application-inspector h2")).toHaveText("Product");
  await expect(page.locator('.react-flow__node[data-id="Other"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="api"]')).toBeVisible();
  await page.getByLabel("Map screen", { exact: true }).selectOption("");
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  await page.getByRole("checkbox", { name: "Services", exact: true }).uncheck();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.getByRole("checkbox", { name: "Services", exact: true }).check();
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Fit map", exact: true }).click();
    await expect.poll(async () => page.locator(".application-canvas").evaluate(canvas => {
      const bounds = canvas.getBoundingClientRect();
      return [...canvas.querySelectorAll(".react-flow__node")].every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom - 40;
      });
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
