import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Run, ServiceMap } from "../shared/model.ts";
import type { ApplicationMap, ApplicationNode, ApplicationEdge, MapEvidence } from "../shared/application-map.ts";
import { decisionMaps } from "./decision-map.ts";
import { identify } from "./screens.ts";
import { normalizedUrl } from "./service-map.ts";
import { pageUrlFromResult } from "./domain.mjs";
import { ExplorationInventory, semanticName, type InterfaceObservation, type ObservedControl } from "./snapshot.ts";

export type SavedInterface = InterfaceObservation & { action?: ObservedControl };
const controlSchema = z.object({
  key: z.string().max(2000), label: z.string().max(160), role: z.string().max(60),
  componentKey: z.string().max(2000).optional(), ref: z.string().max(200).optional(), disabled: z.boolean().optional(),
});
const interfaceSchema = z.object({
  evidenceId: z.number().int().positive(),
  screen: z.object({ key: z.string().max(2048), label: z.string().max(500) }),
  components: z.array(z.object({
    key: z.string().max(2000), label: z.string().max(160), role: z.string().max(60),
    parentKey: z.string().max(2000).optional(),
  })).max(60),
  controls: z.array(controlSchema).max(300), action: controlSchema.optional(), truncated: z.boolean(),
});
export function readInterfaces(dir: string): SavedInterface[] {
  const file = join(dir, "interface.jsonl");
  if (!existsSync(file) || statSync(file).size > 16 * 1024 * 1024) return [];
  return readFileSync(file,"utf8").split("\n").flatMap(line => {
    try {
      const parsed = interfaceSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch { return []; }
  });
}
type Input = { run: Run; interfaces?: SavedInterface[]; serviceMap?: ServiceMap };
const idFor = (kind: string, key: string) => kind + "-" + createHash("sha256").update(key).digest("hex").slice(0, 20);
function mergeEvidence(first: MapEvidence[], next: MapEvidence[]) {
  return [...new Map([...first, ...next].map(ref => [ref.runId + "/" + ref.evidenceId, ref])).values()];
}

export function applicationMap(site: string, inputs: Input[]): ApplicationMap {
  const nodes = new Map<string, ApplicationNode>();
  const edges = new Map<string, ApplicationEdge>();
  const warnings = new Set<string>();
  const actionNodes = new Map<string, string>();
  const eventScreens = new Map<string, string>();
  const controlNodes = new Map<string, string>();
  const componentNodes = new Map<string, string>();
  const networkAliases = new Map<string, Set<string>>();
  const runs = inputs.map(input => input.run);
  function node(value: ApplicationNode) {
    const previous = nodes.get(value.id);
    if (previous) {
      if (value.kind === "component" && value.parentId && previous.parentId && previous.parentId !== value.parentId) {
        previous.shared = true;
        previous.parentId = undefined;
      }
      previous.evidence = mergeEvidence(previous.evidence, value.evidence);
      previous.screenIds = [...new Set([...previous.screenIds, ...value.screenIds])];
      if (value.status === "exercised" || (value.status === "blocked" && previous.status === "pending"))
        previous.status = value.status;
      return previous;
    }
    if (nodes.size >= 6000) { warnings.add("The map reached its 6,000 entity limit."); return; }
    nodes.set(value.id, value);
    return value;
  }
  function edge(source: string, target: string, kind: ApplicationEdge["kind"], label: string, evidence: MapEvidence[], count = 1, contextScreenId?: string) {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const id = idFor("edge", [source, target, kind, label, contextScreenId].join("|"));
    const previous = edges.get(id);
    if (previous) {
      previous.evidence = mergeEvidence(previous.evidence, evidence);
      previous.count += count;
    } else if (edges.size < 12000) edges.set(id, { id, source, target, kind, label, evidence, count, contextScreenId });
    else warnings.add("The map reached its 12,000 connection limit.");
  }
  function screen(key: string, label: string, evidence: MapEvidence[]) {
    const id = idFor("screen", key);
    node({ id, kind: "screen", label, route: key, shared: false, screenIds: [id], status: "observed", evidence });
    return id;
  }

  for (const { run, interfaces } of inputs) {
    const saved = new Map(interfaces?.map(observation => [observation.evidenceId, observation]));
    const inventory = new ExplorationInventory();
    let previousScreen: string | undefined;
    for (const event of run.evidence) {
      const ref = [{ runId: run.id, evidenceId: event.id }];
      const reconstructed = inventory.observe(event);
      const observation = event.ok ? saved.get(event.id) ?? reconstructed.observation : undefined;
      const action = saved.get(event.id)?.action ?? reconstructed.action;
      if (action && previousScreen) {
        const actionId = controlNodes.get(previousScreen + "|" + action.key);
        if (actionId) {
          actionNodes.set(run.id + "/" + event.id, actionId);
          const control = nodes.get(actionId)!;
          control.status = event.ok ? "exercised" : control.status === "pending" ? "blocked" : control.status;
          control.evidence = mergeEvidence(control.evidence, ref);
        }
      }
      if (!observation) continue;
      if (observation.truncated) warnings.add("Some interface snapshots reached the component or control limit.");
      const screenId = screen(observation.screen.key, observation.screen.label, ref);
      if (!nodes.has(screenId)) continue;
      eventScreens.set(run.id + "/" + event.id, screenId);
      const rawUrl = pageUrlFromResult(event.detail);
      const projectedUrl = rawUrl && normalizedUrl(rawUrl);
      const projected = projectedUrl && identify(projectedUrl.href);
      if (projected) {
        const key = run.id + "|" + projected.key;
        const aliases = networkAliases.get(key) ?? new Set<string>();
        aliases.add(screenId);
        networkAliases.set(key, aliases);
      }
      for (const component of observation.components) {
        const id = idFor("component", site + "|" + component.key);
        const candidateParent = component.parentKey ? componentNodes.get(component.parentKey) : screenId;
        const parentId = candidateParent === id ? screenId : candidateParent;
        node({ id, kind: "component", label: component.label, role: component.role, parentId,
          shared: false, screenIds: [screenId], status: "observed", evidence: ref });
        componentNodes.set(component.key, id);
        edge(screenId, id, "uses", "Uses", ref);
        if (parentId && parentId !== screenId) edge(parentId, id, "contains", "Contains", ref);
      }
      for (const control of observation.controls) {
        const parentId = control.componentKey ? componentNodes.get(control.componentKey) ?? screenId : screenId;
        const id = idFor("element", parentId + "|" + control.key);
        node({ id, kind: "element", label: control.label, role: control.role, parentId, shared: false,
          screenIds: [screenId], status: control.disabled ? "blocked" : "pending", evidence: ref });
        if (nodes.has(id)) controlNodes.set(screenId + "|" + control.key, id);
        edge(parentId, id, "contains", "Contains", ref);
      }
      previousScreen = screenId;
    }
    for (const discovery of run.discoveries ?? []) {
      const screenIds = [...new Set((discovery.screenEvidenceIds ?? [discovery.screenEvidenceId])
        .flatMap(evidenceId => eventScreens.get(run.id + "/" + evidenceId) ?? []))];
      if (!screenIds.length) continue;
      const refs = discovery.evidenceIds.map(evidenceId => ({ runId: run.id, evidenceId }));
      const parents: string[] = [];
      for (const screenId of screenIds) {
        let parentId = screenId;
        if (discovery.component) {
          const existing = [...nodes.values()].find(n => n.kind === "component" && n.screenIds.includes(screenId) &&
            semanticName(n.label) === semanticName(discovery.component));
          const componentId = existing?.id ?? idFor("component", site + "|functional|" + semanticName(discovery.component));
          node({ id: componentId, kind: "component", label: discovery.component, role: "functional component",
            parentId: screenId, shared: false, screenIds: [screenId], status: "observed", evidence: refs });
          edge(screenId, componentId, "uses", "Uses", refs);
          parentId = componentId;
        }
        parents.push(parentId);
      }
      const id = idFor("rule", site + "|" + discovery.id);
      node({ id, kind: "rule", label: discovery.capability, parentId: parents[0], shared: false, screenIds,
        description: "Given " + discovery.given + "\nWhen " + discovery.action + "\nThen " + discovery.observed,
        scope: discovery.scope, examples: discovery.examples, status: "exercised", evidence: refs });
      for (const parentId of parents) edge(parentId, id, "explains", "Rule", refs);
    }
    // Existing reports remain usable before incremental recording was available.
    for (const flow of run.report?.flows ?? []) {
      const refs = flow.evidenceIds.filter(evidenceId => run.evidence.some(e => e.id === evidenceId && e.ok))
        .map(evidenceId => ({ runId: run.id, evidenceId }));
      if (!refs.length) continue;
      const screenIds = [...new Set(refs.flatMap(ref => eventScreens.get(run.id + "/" + ref.evidenceId) ?? []))];
      if (!screenIds.length) continue;
      const description = [flow.given ? "Given " + flow.given : "", ...flow.steps.map(step => "When " + step), "Then " + flow.observed].filter(Boolean).join("\n");
      const id = idFor("rule", site + "|" + semanticName([flow.given, ...flow.steps, flow.observed].join(" ")));
      if ([...nodes.values()].some(n => n.kind === "rule" && n.screenIds.some(screenId => screenIds.includes(screenId)) &&
          n.description === description)) continue;
      node({ id, kind: "rule", label: flow.title, parentId: screenIds[0], shared: false, screenIds,
        description,
        status: "exercised", evidence: refs });
      for (const screenId of screenIds) edge(screenId, id, "explains", "Rule", refs);
    }
  }
  for (const map of decisionMaps(runs)) {
    for (const branch of map.branches) {
      if (branch.source.key === branch.target.key) continue;
      const refs = branch.ids.map(evidenceId => ({ runId: branch.runId, evidenceId }));
      const source = screen(branch.source.key, branch.source.label, refs.slice(0, 1));
      const target = screen(branch.target.key, branch.target.label, refs.slice(-1));
      const control = actionNodes.get(branch.runId + "/" + branch.ids[branch.ids.length - 1]);
      edge(control ?? source, target, "navigates", branch.action, refs, 1, source);
    }
  }
  const stats = new Map<string, { count: number; statuses: Set<string>; min: number; max: number; timed: number }>();
  for (const { run, serviceMap } of inputs) {
    if (!serviceMap || !["ready", "partial"].includes(serviceMap.state)) continue;
    if (serviceMap.state === "partial") warnings.add("Some network captures are partial.");
    const operationIds = new Map<string, string>();
    for (const service of serviceMap.services) {
      const id = idFor("service", service.origin);
      node({ id, kind: "service", label: service.origin, shared: true, screenIds: [], status: "observed", evidence: [],
        description: "Observed browser destination" });
      for (const operation of serviceMap.operations.filter(op => op.serviceId === service.id)) {
        const operationId = idFor("operation", service.origin + "|" + operation.method + "|" + operation.path);
        node({ id: operationId, kind: "operation", label: operation.method + " " + operation.path, parentId: id,
          shared: false, screenIds: [], status: "observed", evidence: [] });
        operationIds.set(operation.id, operationId);
        edge(id, operationId, "contains", "Exposes", []);
      }
    }
    const mapScreens = new Map(serviceMap.screens.map(s => [s.id, s]));
    for (const observation of serviceMap.observations) {
      const sourceScreen = mapScreens.get(observation.screenId);
      const operationId = operationIds.get(observation.operationId);
      if (!operationId) continue;
      const refs = observation.evidenceId ? [{ runId: run.id, evidenceId: observation.evidenceId }] : [];
      const operation = nodes.get(operationId);
      if (!operation) continue;
      const metric = stats.get(operationId) ?? { count: 0, statuses: new Set<string>(), min: Infinity, max: 0, timed: 0 };
      metric.count++;
      metric.statuses.add(observation.failed ? "Transport failure" : String(observation.status ?? "Unknown"));
      if (observation.durationMs !== null) {
        metric.min = Math.min(metric.min, observation.durationMs);
        metric.max = Math.max(metric.max, observation.durationMs);
        metric.timed++;
      }
      stats.set(operationId, metric);
      operation.evidence = mergeEvidence(operation.evidence, refs);
      if (!sourceScreen?.key) continue;
      const identified = identify(sourceScreen.key, sourceScreen.label);
      if (!identified) continue;
      const existingId = idFor("screen", identified.key);
      const aliases = networkAliases.get(run.id + "|" + identified.key);
      const eventScreen = observation.evidenceId && eventScreens.get(run.id + "/" + observation.evidenceId);
      const screenId = nodes.has(existingId) ? existingId : aliases?.size === 1 ? [...aliases][0] :
        eventScreen && aliases?.has(eventScreen) ? eventScreen :
          screen(site + "#unidentified-network", "Unidentified network source", refs);
      if (!nodes.has(screenId)) continue;
      const source = observation.evidenceId ? actionNodes.get(run.id + "/" + observation.evidenceId) ?? screenId : screenId;
      edge(source, operationId, "calls", observation.evidenceId ? "During action" : "Observed request", refs, 1, screenId);
      operation.screenIds = [...new Set([...operation.screenIds, screenId])];
      const service = nodes.get(operation.parentId!);
      if (service) {
        service.screenIds = [...new Set([...service.screenIds, screenId])];
        service.evidence = mergeEvidence(service.evidence, refs);
      }
    }
  }
  for (const [id, metric] of stats) {
    nodes.get(id)!.description = metric.count + " requests across captures\nResults " + [...metric.statuses].join(", ") +
      (metric.timed ? "\nDuration " + metric.min + "–" + metric.max + " ms" : "");
  }
  // A repeated boundary becomes one entity shared by the screens that use it.
  // Its controls retain that parent, so there is a single connected subgraph.
  for (const item of nodes.values()) {
    if (["component","rule"].includes(item.kind) && (item.shared || item.screenIds.length > 1)) {
      item.shared = true;
      if (nodes.get(item.parentId ?? "")?.kind === "screen") item.parentId = undefined;
    }
    if (item.parentId && nodes.get(item.parentId)?.shared) item.shared = item.kind === "component";
  }
  function priority(control: ApplicationNode) {
    let parent = nodes.get(control.parentId ?? "");
    let score = control.role === "link" ? 10 : 0;
    while (parent) {
      if (parent.role === "contentinfo") return score + 60;
      if (parent.role === "banner") score += 30;
      parent = nodes.get(parent.parentId ?? "");
    }
    return score;
  }
  const pending = [...nodes.values()].filter(n => n.kind === "screen").map(n => ({
    screenId: n.id, screen: n.label,
    controls: [...nodes.values()].filter(control => control.kind === "element" && control.screenIds.includes(n.id) && control.status === "pending")
      .sort((a,b)=>priority(a)-priority(b)).map(control => {
        const parent = nodes.get(control.parentId ?? "");
        return parent?.kind === "component" ? parent.label + " · " + control.label : control.label;
      }),
  })).filter(entry => entry.controls.length);
  return { site, nodes: [...nodes.values()], edges: [...edges.values()], pending,
    gaps: [...new Set(runs.flatMap(run => run.report?.gaps ?? []))],
    warnings: [...warnings], runIds: runs.map(run => run.id) };
}
