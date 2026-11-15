import type { Evidence, Run } from "../shared/model.ts";
import { identify, type Screen } from "./screens.ts";
import { pageUrlFromResult, sameDomain } from "./domain.mjs";

type Branch = {
  source: Screen; target: Screen; condition: string; action: string; outcome: string;
  external: boolean; runId: string; ids: number[];
};
type SiteMap = { site: string; screens: Screen[]; branches: Branch[] };

function screenAt(event: Evidence) {
  const url = pageUrlFromResult(event.detail);
  return url ? identify(url, event.detail.match(/^- Page Title:\s*(.+)/m)?.[1]) : undefined;
}

const verbs: Record<string,string> = {
  browser_click: "Click", browser_type: "Type into", browser_fill_form: "Fill form",
  browser_press_key: "Press key", browser_select_option: "Select option", browser_navigate_back: "Go back",
  browser_navigate: "Navigate", browser_hover: "Hover over",
};

export function decisionMaps(runs: Run[]): SiteMap[] {
  const sites = new Map<string, SiteMap>();
  for (const run of runs) {
    const site = new URL(run.url).origin;
    const map = sites.get(site) ?? { site, screens: [], branches: [] };
    sites.set(site, map);
    function remember(screen: Screen) {
      if (!map.screens.some(s => s.key === screen.key)) map.screens.push(screen);
    }
    function record(branch: Branch) {
      remember(branch.source);
      remember(branch.target);
      if (!map.branches.some(b => b.source.key === branch.source.key && b.target.key === branch.target.key &&
        b.action === branch.action && b.condition === branch.condition && b.outcome === branch.outcome)) map.branches.push(branch);
    }
    const events = new Map(run.evidence.filter(e => e.ok).map(e => [e.id, e]));
    const described = new Set<number>();
    for (const d of run.report?.decisions ?? []) {
      const before = events.get(d.sourceEvidenceId), after = events.get(d.resultEvidenceId);
      if (!before || !after || before.id >= after.id) continue;
      const source = screenAt(before), target = screenAt(after);
      if (!source || !target || !sameDomain(source.key,site)) continue;
      record({source,target,condition:d.condition,action:d.action,outcome:d.outcome,
        external:!sameDomain(target.key,site),runId:run.id,ids:[before.id,after.id]});
      described.add(after.id);
    }
    // Older reports have evidence-backed flows but no structured decision records.
    if (!run.report?.decisions?.length) {
      for (const flow of run.report?.flows ?? []) {
        const cited = flow.evidenceIds.map(id => events.get(id));
        if (cited.some(e => !e)) continue;
        const screens = cited.map(e => e && screenAt(e)).filter((s): s is Screen => Boolean(s));
        const source = screens[0];
        if (!source || !sameDomain(source.key, site) || screens.some(s => s.key !== source.key)) continue;
        record({source,target:source,condition:"Observed scenario",action:flow.title,outcome:flow.observed,
          external:false,runId:run.id,ids:flow.evidenceIds});
      }
    }
    let previous: {screen: Screen; id: number; feedback: string[]} | undefined;
    let openExternal = new Set<string>();
    for (const event of run.evidence) {
      if (!event.ok) { previous = undefined; continue; }
      const current = screenAt(event);
      const external = new Set(event.externalUrls ?? (event.externalUrl ? [event.externalUrl] : []));
      const feedback = [...event.detail.matchAll(/^\s*- (?:alert|status):\s+(.+)$/gm)].map(match => match[1].trim().slice(0, 240));
      const verb = verbs[event.tool];
      if (current) remember(current);
      if (previous && verb && sameDomain(previous.screen.key, site)) {
        const name = event.element || event.detail.match(/getByRole\([^\n]+?name:\s*['"]([^'"\n]+)/)?.[1];
        const action = name ? verb + " " + name : verb;
        if (current?.key === previous.screen.key && !described.has(event.id)) {
          for (const message of feedback.filter(text => !previous!.feedback.includes(text))) {
            record({source:previous.screen,target:current,condition:"Visible feedback",action,outcome:message,
              external:false,runId:run.id,ids:[previous.id,event.id]});
          }
        }
        const targets = [current, ...[...external].filter(url=>!openExternal.has(url)).map(url=>identify(url))];
        for (const target of targets) {
          if (!target || previous.screen.key === target.key || (described.has(event.id) && target.key === current?.key)) continue;
          record({source:previous.screen,target,condition:"Observed navigation",action,outcome:"Opened " + target.label,
            external:!sameDomain(target.key,site),runId:run.id,ids:[previous.id,event.id]});
        }
      }
      openExternal = external;
      previous = current ? {screen:current,id:event.id,feedback} : undefined;
    }
  }
  return [...sites.values()].filter(m=>m.screens.length);
}
