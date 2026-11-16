import {createHash} from "node:crypto";
import {unlinkSync} from "node:fs";
import { identify, screensFor } from "./screens.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportSchema, type Run } from "../shared/model.ts";
import { Store } from "./store.ts";

const line = (s:string) => s.replace(/\s+/g," ").trim();
const normalizeClause = (value: string) => line(value).normalize("NFKC").toLowerCase();
function mergeOccurrences<T extends { runId: string; scenarioId: string }>(first: T[], next: T[]) {
  const unique = new Map<string, T>();
  for (const occurrence of [...first, ...next])
    unique.set(occurrence.runId + "/" + occurrence.scenarioId, occurrence);
  return [...unique.values()];
}
function featureFor(host: string, scenarios: { group: string; state: string; ids: number[]; groupKey: string; gherkin: string }[]) {
  return ["# language: en", "Feature: Exploration of " + host, ...scenarios.map(s =>
    "\n  # " + line(s.group) + " · " + s.state + " · Evidence: " + s.ids.join(", ") +
    "\n  " + (s.groupKey === "smoke" ? "@smoke\n  " : "") + s.gherkin.replaceAll("\n", "\n  "))].join("\n") + "\n";
}
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
  for (const discovery of run.discoveries ?? []) {
    const gherkin = ["Scenario: " + line(discovery.capability),
      "  Given " + line(discovery.given), "  When " + line(discovery.action),
      "  Then " + line(discovery.observed)].join("\n");
    scenarios.push({ title: discovery.capability, state: "Observed rule", ids: discovery.evidenceIds,
      gherkin, legacy: gherkin });
  }
  // Without a final proposal, retain concrete page observations as drafts.
  if(!scenarios.length) {
    let previous="";
    const seenScreens = new Set<string>();
    for(const e of events) {
      if(!e.ok) continue;
      const url=e.detail.match(/^- Page URL: (https?:\/\/\S+)/m)?.[1];
      const title=e.detail.match(/^- Page Title: (.+)/m)?.[1];
      if(!url || !title || previous===url) continue;
      const start=previous||run.url; previous=url;
      const identified = identify(url,title);
      const screenKey = identified?.key ?? url;
      if (seenScreens.has(screenKey)) continue;
      seenScreens.add(screenKey);
      const screen = identified?.label ?? title;
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
    const id = createHash("sha256").update(JSON.stringify([s.title,s.ids,legacy])).digest("hex");
    const clauses = s.gherkin.split("\n").slice(1).map(normalizeClause);
    const fingerprint = createHash("sha256").update(JSON.stringify([
      new URL(run.url).origin, screens.map(screen => screen.key),
      s.state === "Observed draft" ? "screen-draft" : clauses,
    ])).digest("hex");
    return {...scenario,screens,group,groupKey,id,fingerprint,
      occurrences:[{runId:run.id,scenarioId:id,ids:s.ids,createdAt:run.createdAt}]};
  }).sort((a,b)=>a.group.localeCompare(b.group,"es")||a.title.localeCompare(b.title,"es"));
  const exclusions=new Set(store.exclusions(run.id).scenarios);
  const unique = new Map<string, typeof classified[number]>();
  for (const scenario of classified.filter(s=>!exclusions.has(s.id))) {
    const existing = unique.get(scenario.fingerprint);
    if (existing) {
      existing.ids = [...new Set([...existing.ids, ...scenario.ids])];
      existing.occurrences = mergeOccurrences(existing.occurrences, scenario.occurrences);
    } else unique.set(scenario.fingerprint, scenario);
  }
  const visible=[...unique.values()];
  const feature=featureFor(host,visible);
  if(visible.length) {
    const folder=join(store.root,"library"); mkdirSync(folder,{recursive:true,mode:0o700});
    const path=join(folder,run.id+".feature");
    if(!existsSync(path)||readFileSync(path,"utf8")!==feature){writeFileSync(path+".tmp",feature,{mode:0o600});renameSync(path+".tmp",path);}
  }
  else {const path=join(store.root,"library",run.id+".feature");if(existsSync(path))unlinkSync(path);}
  return {id:run.id,url:run.url,status:run.status,createdAt:run.createdAt,scenarios:includeExcluded?classified:visible,feature};
}
export type LibraryEntry=ReturnType<typeof libraryEntry>;

export function consolidatedLibrary(entries: LibraryEntry[]): LibraryEntry[] {
  const owners = new Map<string, LibraryEntry["scenarios"][number]>();
  const result: LibraryEntry[] = [];
  const ordered = [...entries].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  for (const entry of ordered) {
    const scenarios: LibraryEntry["scenarios"] = [];
    for (const scenario of entry.scenarios) {
      const existing = owners.get(scenario.fingerprint);
      if (existing) existing.occurrences = mergeOccurrences(existing.occurrences, scenario.occurrences);
      else {
        const copy = { ...scenario, occurrences: [...scenario.occurrences] };
        owners.set(scenario.fingerprint, copy);
        scenarios.push(copy);
      }
    }
    if (scenarios.length) result.push({ ...entry, scenarios, feature: featureFor(new URL(entry.url).hostname, scenarios) });
  }
  return result;
}
