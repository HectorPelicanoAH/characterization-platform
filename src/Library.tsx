import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Download, FileCode2, Folder, FolderOpen, Layers3, Search, Sparkles, Trash2, X } from "lucide-react";
import type { LibraryEntry } from "../server/library";
import { RefineScenario } from "./RefineScenario";

type Scenario = LibraryEntry["scenarios"][number];
type Row = { entry: LibraryEntry; scenario: Scenario; key: string; site: string; screen: string };
type Group = { key: string; site: string; label: string; rows: Row[] };
type Selection = { kind: "all" } | { kind: "site" | "screen"; id: string } | { kind: "scenario"; id: string; screen: string };

function feature(rows: Row[], label: string) {
  return ["# language: en", "Feature: " + label.replace(/\s+/g, " "), ...rows.map(({ entry, scenario }) =>
    "\n  # " + new URL(entry.url).host + " · " + scenario.group + " · " + scenario.state + " · Evidence: " + scenario.ids.join(", ") +
    "\n  " + (scenario.groupKey === "smoke" ? "@smoke\n  " : "") + scenario.gherkin.replaceAll("\n", "\n  "))].join("\n") + "\n";
}

function Gherkin({ value }: { value: string }) {
  return <pre className="library-gherkin"><code>{value.split("\n").map((line, index) => {
    const match = line.match(/^(\s*)(Scenario Outline:|Scenario:|Given\b|When\b|Then\b|And\b|But\b|Examples:)(.*)$/);
    const text = match ? match[3] : line;
    return <React.Fragment key={index}>{index > 0 && "\n"}{match && <>{match[1]}<span className="gherkin-keyword">{match[2]}</span></>}
      {text.split(/(<[^<>]+>)/g).map((part, i) => part.startsWith("<") && part.endsWith(">") ? <span className="gherkin-parameter" key={i}>{part}</span> : part)}</React.Fragment>;
  })}</code></pre>;
}

export function Library({ runId, revision, onRun }: { runId?: string; revision?: string; onRun?: (id: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [refining, setRefining] = useState<{ entry: LibraryEntry; scenario: Scenario }>();
  const [removing, setRemoving] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    fetch(runId ? "/api/runs/" + runId + "/scenarios" : "/api/library", { headers: { "X-Characterize": "1" }, signal: abort.signal })
      .then(async response => { if (!response.ok) throw Error("Could not open the library"); return response.json(); })
      .then(value => { setEntries(runId ? [value] : value); setError(""); })
      .catch(error => { if (!abort.signal.aborted) setError(error.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [runId, revision, refresh]);

  const rows = useMemo(() => entries.flatMap(entry => entry.scenarios.map(scenario => {
    const site = new URL(entry.url).origin;
    return { entry, scenario, site, key: entry.id + "/" + scenario.id, screen: site + "|" + scenario.groupKey };
  })).sort((a, b) => a.site.localeCompare(b.site) || a.scenario.group.localeCompare(b.scenario.group) || a.scenario.title.localeCompare(b.scenario.title)), [entries]);
  const search = query.trim().toLowerCase();
  const matches = useMemo(() => search ? rows.filter(row => [row.site, row.scenario.group, row.scenario.title, row.scenario.gherkin].join(" ").toLowerCase().includes(search)) : rows, [rows, search]);
  const groups = useMemo(() => {
    const result = new Map<string, Group>();
    for (const row of matches) {
      const group = result.get(row.screen) ?? { key: row.screen, site: row.site, label: row.scenario.group, rows: [] };
      group.rows.push(row); result.set(row.screen, group);
    }
    return [...result.values()];
  }, [matches]);
  const sites = [...new Set(groups.map(group => group.site))];
  let active = selection;
  const selectedId = "id" in selection ? selection.id : "";
  if (active.kind === "scenario" && !matches.some(row => row.key === selectedId)) {
    const parent = active.screen;
    active = groups.some(group => group.key === parent) ? { kind: "screen", id: parent } : { kind: "all" };
  }
  const activeId = "id" in active ? active.id : "";
  if (active.kind === "screen" && !groups.some(group => group.key === activeId) || active.kind === "site" && !sites.includes(activeId)) active = { kind: "all" };
  const current = active;
  const selectedRows = matches.filter(row => current.kind === "all" || current.kind === "site" && row.site === current.id || current.kind === "screen" && row.screen === current.id || current.kind === "scenario" && row.key === current.id);
  const selectedGroup = current.kind === "screen" ? groups.find(group => group.key === current.id) : current.kind === "scenario" ? groups.find(group => group.key === current.screen) : undefined;
  const selectedSite = current.kind === "site" ? current.id : selectedGroup?.site;
  const label = selectedGroup?.label ?? (selectedSite ? new URL(selectedSite).host : search ? "Search results" : "All scenarios");
  const showGroups = current.kind === "all" || current.kind === "site";

  function toggle(key: string, defaultOpen = false) { setExpanded(old => ({ ...old, [key]: !(old[key] ?? defaultOpen) })); }
  async function remove(entry: LibraryEntry, scenario: Scenario) {
    if (!window.confirm("Remove “" + scenario.title + "” and its " + scenario.occurrences.length + " grouped observations from the library and its Gherkin files? The original report and evidence will be kept.")) return;
    setRemoving(true); setError("");
    try {
      const response = await fetch("/api/library/" + entry.id + "/" + scenario.id + (runId ? "" : "?allObservations=1"), { method: "DELETE", headers: { "X-Characterize": "1" } });
      const value = await response.json(); if (!response.ok) throw Error(value.error);
      setEntries(runId ? [value] : value);
    } catch (error) { setError((error as Error).message); } finally { setRemoving(false); }
  }

  function card(row: Row) {
    const { entry, scenario } = row;
    const open = openCards[row.key] ?? (current.kind === "scenario" && current.id === row.key);
    return <details className="flow-card library-scenario" key={row.key} open={open}>
      <summary onClick={event => { event.preventDefault(); setOpenCards(old => ({ ...old, [row.key]: !open })); }}>
        <FileCode2 size={17} aria-hidden="true" /><strong>{scenario.title}</strong>
        <span className="badge">{scenario.state}</span><ChevronRight className="scenario-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="flow-body">
        {scenario.groupKey === "smoke" && <p className="library-screen-path">Screens: {scenario.screens.map(screen => screen.label).join(" → ")}</p>}
        <Gherkin value={scenario.gherkin} />
        <div className="library-observations"><h4>Evidence <span>{scenario.occurrences.length} {scenario.occurrences.length === 1 ? "observation" : "observations"}</span></h4>
          {scenario.occurrences.map(occurrence => <div className="scenario-evidence" key={occurrence.runId + "/" + occurrence.scenarioId}>
            <span className="evidence-ids">{occurrence.ids.map(id => "#" + id).join(", ")}</span>
            <time dateTime={occurrence.createdAt}>{new Date(occurrence.createdAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time>
            {onRun && <button className="text-button" onClick={() => onRun(occurrence.runId)}>View observation</button>}
          </div>)}
        </div>
        <div className="scenario-actions">
          <button className="text-button" disabled={entry.status === "running"} onClick={() => setRefining({ entry, scenario })}><Sparkles size={14} />Refine with AI</button>
          {onRun && <button className="text-button" onClick={() => onRun(entry.id)}>View run and evidence</button>}
          <button className="text-button scenario-delete" disabled={removing || entry.status === "running"} onClick={() => void remove(entry, scenario)}><Trash2 size={14} />Delete scenario</button>
        </div>
      </div>
    </details>;
  }

  return <section className={"scenario-library library-page" + (runId ? " library-compact" : "")}>
    <div className="library-heading">
      <div>{runId ? <h2>Gherkin scenarios</h2> : <h1>Local library</h1>}<p>Observed behavior, organized by application and screen.</p></div>
      {rows.length > 0 && <span className="library-total">{rows.length} {rows.length === 1 ? "scenario" : "scenarios"}</span>}
    </div>
    {error && <p role="alert" className="alert error">{error}</p>}
    {loading && !rows.length ? <p role="status" className="library-empty">Loading scenarios…</p> : !rows.length ? <div className="panel library-empty"><FolderOpen size={30} /><h3>Your library starts with an exploration</h3><p>Recorded scenarios will appear here, grouped into application and screen folders.</p></div> : <>
      <label className="library-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Search scenarios" placeholder="Find a scenario, screen or application…" value={query}
        onChange={event => { setQuery(event.target.value); setSelection({ kind: "all" }); }} />
        {query && <button type="button" aria-label="Clear scenario search" onClick={() => setQuery("")}><X size={15} /></button>}</label>
      <div className="library-workspace">
        <nav className="library-explorer" aria-label="Scenario folders">
          <div className="library-explorer-label">EXPLORER <span>{sites.length} {sites.length === 1 ? "app" : "apps"}</span></div>
          <button type="button" className={"library-tree-row library-all" + (current.kind === "all" ? " selected" : "")} aria-current={current.kind === "all" ? "true" : undefined} onClick={() => setSelection({ kind: "all" })}>
            <Layers3 size={16} /><span>All scenarios</span><small>{matches.length}</small>
          </button>
          {sites.map(site => {
            const siteGroups = groups.filter(group => group.site === site);
            const siteKey = "site:" + site;
            const siteOpen = !!search || (expanded[siteKey] ?? sites.length === 1);
            return <details className="library-site-folder" key={site} open={siteOpen}>
              <summary className={"library-tree-row" + (current.kind === "site" && current.id === site ? " selected" : "")} title={site} onClick={event => { event.preventDefault(); toggle(siteKey, sites.length === 1); setSelection({ kind: "site", id: site }); }}>
                <ChevronRight className="folder-chevron" size={13} />{siteOpen ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{new URL(site).host}</span><small>{siteGroups.reduce((count, group) => count + group.rows.length, 0)}</small>
              </summary>
              <div className="library-folder-contents">{siteGroups.map(group => {
                const groupOpen = !!search || (expanded[group.key] ?? false);
                return <details className="library-screen-folder" key={group.key} open={groupOpen}>
                  <summary className={"library-tree-row" + (selectedGroup?.key === group.key ? " selected" : "")} onClick={event => { event.preventDefault(); toggle(group.key); setSelection({ kind: "screen", id: group.key }); }}>
                    <ChevronRight className="folder-chevron" size={13} />{groupOpen ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{group.label}</span><small>{group.rows.length}</small>
                  </summary>
                  <div className="library-scenario-leaves">{group.rows.map(row => <button type="button" className={"library-tree-row library-leaf" + (current.kind === "scenario" && current.id === row.key ? " selected" : "")}
                    key={row.key} title={row.scenario.title} aria-current={current.kind === "scenario" && current.id === row.key ? "true" : undefined}
                    onClick={() => { setSelection({ kind: "scenario", id: row.key, screen: group.key }); setOpenCards(old => ({ ...old, [row.key]: true })); }}>
                    <FileCode2 size={14} /><span>{row.scenario.title}</span>
                  </button>)}</div>
                </details>;
              })}</div>
            </details>;
          })}
          {!matches.length && <p className="library-no-folders">No matching scenarios.</p>}
        </nav>
        <div className="library-content" aria-label="Scenario details" aria-busy={loading}>
          <header className="library-content-heading"><div>
            {selectedSite && <p className="library-breadcrumb">{new URL(selectedSite).host}{selectedGroup && <> <ChevronRight size={12} /> {selectedGroup.label}</>}</p>}
            <h2>{label}</h2><p>{selectedRows.length} {selectedRows.length === 1 ? "scenario" : "scenarios"}{search && " matching “" + query.trim() + "”"}</p>
          </div>{selectedRows.length > 0 && <a className="library-download" download={label.replace(/[^\p{L}0-9_-]+/gu, "-") + ".feature"} href={"data:text/plain;charset=utf-8," + encodeURIComponent(feature(selectedRows, label))}><Download size={15} />Download .feature</a>}</header>
          {!selectedRows.length ? <div className="library-empty"><Search size={26} /><h3>No scenarios found</h3><p>Try a different name or a phrase from the behavior.</p></div> : showGroups ? groups.filter(group => selectedRows.some(row => row.screen === group.key)).map(group => <section className="library-test-group" key={group.key}>
            <div className="library-group-heading"><Folder size={15} /><h3>{group.label}</h3><span>{new URL(group.site).host}</span><small>{group.rows.length}</small></div>
            {group.rows.map(card)}
          </section>) : selectedRows.map(card)}
        </div>
      </div>
    </>}
    {refining && <RefineScenario {...refining} onClose={() => setRefining(undefined)} onSaved={() => { setRefining(undefined); setRefresh(value => value + 1); }} />}
  </section>;
}
