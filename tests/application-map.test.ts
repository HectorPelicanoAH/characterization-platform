import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { applicationMap } from "../server/application-map.ts";
import { interfaceObservation, ExplorationInventory } from "../server/snapshot.ts";
import { readDiscoveries } from "../server/discoveries.ts";
import { discoverySchema } from "../shared/discovery.ts";
import { runInputSchema, type Run, type Evidence } from "../shared/model.ts";
import { emptyServiceMap } from "../server/service-map.ts";
import { identify } from "../server/screens.ts";
import { Store } from "../server/store.ts";
import { libraryEntry } from "../server/library.ts";
import { agentPrompt } from "../server/agent.ts";
import { applicationLayout } from "../src/application-layout.ts";

const page = (id: number, path: string, body = "", tool = "browser_snapshot", element?: string): Evidence => ({
  id, tool, element, at: new Date().toISOString(), ok: true,
  detail: "- Page URL: https://app.test" + path + "\n### Snapshot\n" +
    '- banner:\n  - navigation "Main":\n    - link "Catalog" [ref=c' + id + ']\n    - button "Search" [ref=s' + id + ']\n- main:\n' + body,
});
const sampleRun = (events: Evidence[]): Run => ({
  ...runInputSchema.parse({ url: "https://app.test", provider: "codex" }),
  id: randomUUID(), status: "cancelled", phase: "", createdAt: new Date().toISOString(),
  evidence: events, logs: [], contextFiles: [], warnings: [],
});

test("backtracking keeps untried sibling controls and refreshes page refs", () => {
  const inventory = new ExplorationInventory();
  inventory.observe(page(1, "/"));
  const next = inventory.observe(page(2, "/catalog", '  - button "Filter" [ref=f2]', "browser_click"), "c1");
  assert.equal(next.action?.label, "Catalog");
  assert.equal(inventory.plan().find(screen => screen.screen === "Home")?.exercised, 1);
  inventory.observe(page(3, "/", "", "browser_navigate_back"));
  const home = inventory.plan().find(screen => screen.current)!;
  assert.equal(home.screen, "Home");
  assert.deepEqual(home.pending.map(control => control.label), ["Search"]);
  assert.equal(home.pending[0].ref, "s3");
  inventory.observe({ id:4, tool:"browser_click", ok:false, at:"",detail:"Click failed" }, "s3");
  assert.equal(inventory.plan().find(screen => screen.current)?.blocked,1);
});

test("application graph promotes shared boundaries and links navigation, rules and services", () => {
  const events = [
    page(1, "/es/es/cart", '  - form "Basket":\n    - button "Update quantity" [ref=q1]'),
    page(2, "/catalog", '  - region "Filters":\n    - checkbox "Available" [ref=a2]', "browser_click", "Catalog"),
  ];
  const run = sampleRun(events);
  run.discoveries = [{
    ...discoverySchema.parse({ capabilityKey:"catalog-availability",capability:"Availability filter",component:"Filters",
      given:"the catalog contains available items",action:"apply the availability filter",
      observed:"the visible items satisfy the selected availability",evidenceIds:[2],screenEvidenceId:2 }),
    id:"availability-rule",at:new Date().toISOString(),
  }];
  run.report = { summary:"Distinct prerequisites",decisions:[],gaps:[],flows:[
    {title:"Unavailable item",given:"the item is unavailable",steps:["try the action"],observed:"The action is unavailable",evidenceIds:[2],testCode:"generated"},
    {title:"Restricted action",given:"the user lacks permission",steps:["try the action"],observed:"The action is unavailable",evidenceIds:[2],testCode:"generated"},
  ] };
  const network = emptyServiceMap(run.id,"ready");
  network.services=[{id:"backend",origin:"https://api.test",external:true}];
  network.operations=[{id:"get-items",serviceId:"backend",method:"GET",path:"/items"}];
  network.screens=[{id:"catalog",key:"https://app.test/catalog",label:"Catalog",page:"page1"}];
  network.observations=[{id:"request1",operationId:"get-items",screenId:"catalog",resourceType:"fetch",
    startedMs:100,status:200,failed:false,durationMs:42,evidenceId:2}];
  const map = applicationMap("https://app.test",[{run,serviceMap:network}]);
  const header=map.nodes.filter(node=>node.kind==="component"&&node.label==="Header");
  assert.equal(header.length,1);
  assert.equal(header[0].shared,true);
  assert.equal(header[0].parentId,undefined);
  assert.equal(header[0].screenIds.length,2);
  const filters=map.nodes.find(node=>node.kind==="component"&&node.label==="Filters")!;
  assert.equal(map.nodes.find(n=>n.id===filters.parentId)?.kind,"screen");
  assert.equal(map.nodes.filter(node=>node.kind==="service").length,1);
  assert.equal(map.edges.filter(edge=>edge.kind==="navigates").length,1);
  assert.equal(map.nodes.find(node=>node.label==="GET /items")?.description?.includes("200"),true);
  assert.equal(map.nodes.find(node=>node.kind==="rule")?.parentId,filters.id);
  assert.equal(map.nodes.filter(node=>node.kind==="rule").length,3);
  assert.ok(map.pending.some(entry=>entry.controls.some(control=>control.endsWith("Available"))));
  const observed=map.edges.find(edge=>edge.kind==="calls")!;
  assert.deepEqual(observed.evidence,[{runId:run.id,evidenceId:2}]);
  assert.ok(map.nodes.every(node=>!node.parentId||map.nodes.some(parent=>parent.id===node.parentId)));
  const overview = applicationLayout(map,"screens",false,true);
  const navigation = overview.edges.find(edge=>edge.label==="Navigates")!;
  assert.equal(overview.nodes.find(node=>node.id===navigation.source)?.data.entity.kind,"screen");
  assert.equal(overview.nodes.find(node=>node.id===navigation.target)?.data.entity.kind,"screen");
  const cart = map.nodes.find(node=>node.kind==="screen"&&node.label==="Cart")!;
  const focused = applicationLayout(map,"elements",false,true,cart.id);
  assert.equal(focused.nodes.filter(node=>node.data.entity.kind==="screen").length,2);
  assert.deepEqual(applicationMap("https://app.test",[{run,serviceMap:network}]),map);
});

test("screens group locale variants and image galleries retain a functional identity", () => {
  assert.equal(identify("https://app.test/es/es/cart")?.key,identify("https://app.test/en/gb/cart")?.key);
  assert.equal(identify("https://app.test/en-US/cart")?.label,"Cart");
  const first=interfaceObservation(page(1,"/es/es/p/red-item/123",'  - list "Imágenes de Producto Rojo":\n    - button "Zoom" [ref=z1]'))!;
  const second=interfaceObservation(page(2,"/en/gb/p/blue-item/456",'  - list "Images of Blue Product":\n    - button "Zoom" [ref=z2]'))!;
  assert.equal(first.screen.key,second.screen.key);
  assert.equal(first.components.at(-1)?.key,second.components.at(-1)?.key);
});

test("incremental rules survive incomplete reports and reject invented evidence", async () => {
  const dir=await mkdtemp(join(tmpdir(),"app-discoveries-"));
  try {
    const store=new Store(dir);
    const run=sampleRun([page(1,"/catalog")]);
    store.saveRun(run);
    const recorded={...discoverySchema.parse({
      capabilityKey:"catalog-filter",capability:"Filter the catalog",given:"the catalog is populated",
      action:"apply an available filter",observed:"the selected filter becomes active",
      examples:[{dimension:"Market",value:"ES"}],evidenceIds:[1],screenEvidenceId:1,
    }),id:"rule-1",at:new Date().toISOString()};
    await writeFile(join(store.runDir(run.id),"discoveries.jsonl"),
      JSON.stringify(recorded)+"\n"+JSON.stringify({...recorded,id:"invented",evidenceIds:[99]})+'\n{"id":');
    run.discoveries=readDiscoveries(store.runDir(run.id),run.evidence);
    assert.equal(run.discoveries.length,1);
    const entry=libraryEntry(store,run);
    assert.equal(entry.scenarios[0].state,"Observed rule");
    assert.match(entry.feature,/Then the selected filter becomes active/);
    assert.doesNotMatch(entry.feature,/Market|ES/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("discovery contract asks for backtracking and separates market examples", () => {
  const prompt=agentPrompt(runInputSchema.parse({url:"https://app.test",provider:"codex",scope:"exhaustive"}),
    {context:"",directories:[]},{files:[],warnings:[],characters:0});
  assert.match(prompt,/backtracking/);
  assert.match(prompt,/record_discovery/);
  assert.match(prompt,/get_discovery_plan/);
  assert.match(prompt,/market-specific/);
  assert.doesNotMatch(prompt,/25.+50 flujos|Orientación.+flujos/);
});
