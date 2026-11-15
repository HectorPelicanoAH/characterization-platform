import {createHash} from "node:crypto";
import {unlinkSync} from "node:fs";
import { identify, screensFor } from "./screens.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportSchema, type Run } from "../shared/model.ts";
import { Store } from "./store.ts";

const line = (s:string) => s.replace(/\s+/g," ").trim();
export function libraryEntry(store:Store, run:Run, includeExcluded=false) {
  const dir=store.runDir(run.id);
  let flows: unknown = run.report?.flows;
  if (!flows && existsSync(join(dir,"response.json"))) {
    try { flows=JSON.parse(readFileSync(join(dir,"response.json"),"utf8")).flows; } catch {}
  }
  const events=run.evidence;
  const ok=new Set(events.filter(e=>e.ok).map(e=>e.id));
  const scenarios:{title:string;state:string;gherkin:string;legacy:string;ids:number[]}[]=[];
  const host=new URL(run.url).hostname;
  for (const raw of Array.isArray(flows)?flows:[]) {
    const parsed=reportSchema.shape.flows.element.safeParse(raw);
    if(!parsed.success) continue;
    const f=parsed.data;
    const state=f.evidenceIds.every(id=>ok.has(id))?"Documented":"Review evidence";
    const first = events.findIndex(event => event.ok && f.evidenceIds.includes(event.id));
    const firstEvent = events[first];
    const before = events[first-1];
    const contextEvent = firstEvent?.tool === "browser_snapshot" ? firstEvent : before?.ok ? before : undefined;
    const screen = contextEvent && screensFor([contextEvent.id], [contextEvent])[0];
    const given = f.given || (screen && !screen.label.startsWith("/") ? "the user is on the " + screen.label + " screen" : "");
    const gherkin = ["Scenario: "+line(f.title), ...(given ? ["  Given "+line(given)] : []),
      ...f.steps.map((step,i)=>(i ? "  And " : "  When ")+line(step)), "  Then "+line(f.observed)].join("\n");
    scenarios.push({title:f.title,state,ids:f.evidenceIds,gherkin,legacy:[
      "Escenario: "+line(f.title),"  Dado que la URL inicial es "+run.url,
      ...f.steps.map((s,i)=>(i?"  Y ":"  Cuando ")+line(s)),
      "  Entonces "+line(f.observed)].join("\n")});
  }
  // Without a final proposal, retain concrete page observations as drafts.
  if(!scenarios.length) {
    let previous="";
    for(const e of events) {
      if(!e.ok) continue;
      const url=e.detail.match(/^- Page URL: (https?:\/\/\S+)/m)?.[1];
      const title=e.detail.match(/^- Page Title: (.+)/m)?.[1];
      if(!url || !title || previous===url) continue;
      const start=previous||run.url; previous=url;
      const screen = identify(url,title)?.label ?? title;
      const gherkin = "Scenario: View the "+line(screen)+" screen\n  When the user opens the "+line(screen)+" screen\n  Then the displayed page title is "+line(title);
      scenarios.push({title:line(title),state:"Observed draft",ids:[e.id],gherkin,legacy:
        "Escenario: "+line(title)+"\n  Dado que el recorrido parte de "+start+"\n  Cuando se observa la página tras "+e.tool+"\n  Entonces la URL visible es "+url+"\n  Y el título es "+line(title)});
    }
  }
  const classified=scenarios.map(s=>{
    const screens=screensFor(s.ids,events);
    const group=screens.length>1?"Smoke":screens[0]?.label??"Unknown screen";
    const groupKey=screens.length>1?"smoke":screens[0]?.key??"unknown";
    // Preserve scenario IDs (including existing exclusions) across display languages.
    const {legacy,...scenario}=s;
    return {...scenario,screens,group,groupKey,id:createHash("sha256").update(JSON.stringify([s.title,s.ids,legacy])).digest("hex")};
  }).sort((a,b)=>a.group.localeCompare(b.group,"es")||a.title.localeCompare(b.title,"es"));
  const exclusions=new Set(store.exclusions(run.id).scenarios);
  const visible=classified.filter(s=>!exclusions.has(s.id));
  const feature=["# language: en","Feature: Exploration of "+host,...visible.map(s=>"\n  # "+line(s.group)+" · "+s.state+" · Evidence: "+s.ids.join(", ")+"\n  "+(s.groupKey==="smoke"?"@smoke\n  ":"")+s.gherkin.replaceAll("\n","\n  "))].join("\n")+"\n";
  if(visible.length) {
    const folder=join(store.root,"library"); mkdirSync(folder,{recursive:true,mode:0o700});
    const path=join(folder,run.id+".feature");
    if(!existsSync(path)||readFileSync(path,"utf8")!==feature){writeFileSync(path+".tmp",feature,{mode:0o600});renameSync(path+".tmp",path);}
  }
  else {const path=join(store.root,"library",run.id+".feature");if(existsSync(path))unlinkSync(path);}
  return {id:run.id,url:run.url,status:run.status,createdAt:run.createdAt,scenarios:includeExcluded?classified:visible,feature};
}
export type LibraryEntry=ReturnType<typeof libraryEntry>;
