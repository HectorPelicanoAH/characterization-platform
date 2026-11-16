import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { AppWindow, Component, MousePointer2, Server, FileCode2, GitBranch, Focus, ArrowUpLeft, Search } from "lucide-react";
import type { ApplicationMap as MapData, ApplicationNode, MapEvidence } from "../shared/application-map";
import { applicationLayout, type EntityNode, type RelationEdge } from "./application-layout";
import "@xyflow/react/dist/style.css";

const icons = { screen: AppWindow, component: Component, element: MousePointer2, service: Server, operation: FileCode2, rule: GitBranch };
const Entity = memo(function Entity({ data, selected }: NodeProps<EntityNode>) {
  const { entity, childCount } = data;
  const Icon = icons[entity.kind];
  return <div className={"application-entity " + entity.kind + (selected ? " selected" : "")}>
    <Handle id="in-left" type="target" position={Position.Left} isConnectable={false} />
    <Handle id="in-right" type="target" position={Position.Right} isConnectable={false} />
    <header><Icon size={16} /><div><small>{entity.shared && entity.kind === "component" ? "Shared component" : entity.kind}</small>
      <strong>{entity.label}</strong></div>
      {entity.kind === "element" && <span title={entity.status} className={"entity-state " + entity.status} />}
    </header>
    {childCount === 0 && entity.kind === "screen" && <p>{data.ruleCount} recorded rules</p>}
    <Handle id="out-right" type="source" position={Position.Right} isConnectable={false} />
    <Handle id="out-left" type="source" position={Position.Left} isConnectable={false} />
  </div>;
});
const nodeTypes = { entity: Entity };

export function ApplicationMap({ initialSite, onEvidence, onExplore }: {
  initialSite?: string;
  onEvidence: (runId: string, evidenceId: number) => void;
  onExplore: (site: string, screen: string) => void;
}) {
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState(initialSite ?? "");
  const [map, setMap] = useState<MapData>();
  const [error, setError] = useState("");
  const [detail, setDetail] = useState("screens");
  const [showRules, setShowRules] = useState(false);
  const [showServices, setShowServices] = useState(true);
  const [focus, setFocus] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedRelations, setSelectedRelations] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [instance, setInstance] = useState<ReactFlowInstance<EntityNode, RelationEdge>>();
  const [nodes, setNodes, onNodesChange] = useNodesState<EntityNode>([]);
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvas.current || !instance) return;
    let frame: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void instance.fitView({ padding: 0.15, duration: 150 }); });
    });
    observer.observe(canvas.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [instance]);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/application-map/sites", { headers: { "X-Characterize": "1" } })
      .then(async response => { if (!response.ok) throw Error("Could not load application sites."); return response.json(); })
      .then((value: string[]) => { if (live) { setSites(value); setSite(old => value.includes(old) ? old : value[0] ?? ""); } })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!site) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setMap(undefined);
    setFocus(undefined);
    setSelectedId(undefined);
    setSelectedRelations([]);
    async function refresh() {
      try {
        const response = await fetch("/api/application-map?site=" + encodeURIComponent(site), { headers: { "X-Characterize": "1" } });
        if (!response.ok) throw Error("Could not load the application map.");
        const value: MapData = await response.json();
        if (live) { setMap(old => JSON.stringify(old) === JSON.stringify(value) ? old : value); setError(""); }
      } catch (e) { if (live) setError((e as Error).message); }
      if (live) timer = setTimeout(refresh, 10000);
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [site]);
  const layout = useMemo(() => map ? applicationLayout(map, detail, showRules, showServices, focus) : { nodes: [], edges: [] },
    [map, detail, showRules, showServices, focus]);
  useEffect(() => {
    setNodes(layout.nodes);
    const frame = requestAnimationFrame(() => { void instance?.fitView({ padding: 0.15, duration: 250 }); });
    return () => cancelAnimationFrame(frame);
  }, [layout, setNodes, instance]);
  const selected = map?.nodes.find(n => n.id === selectedId);
  const relations = map?.edges.filter(edge => selectedRelations.includes(edge.id)) ?? [];
  const refs = selected?.evidence ?? [...new Map(relations.flatMap(r => r.evidence).map(ref => [ref.runId + "/" + ref.evidenceId, ref])).values()];
  const screens = map?.nodes.filter(n => n.kind === "screen") ?? [];
  const relatedRules = selected && map?.nodes.filter(n => n.kind === "rule" &&
    (selected.kind === "screen" ? n.screenIds.includes(selected.id) : n.parentId === selected.id));
  const relatedControls = selected && map?.nodes.filter(n => n.kind === "element" &&
    (selected.kind === "screen" ? n.screenIds.includes(selected.id) : n.parentId === selected.id));
  const relatedEntities = selected && map?.nodes.filter(n =>
    selected.kind === "screen" ? n.kind === "component" && n.screenIds.includes(selected.id) :
      n.parentId === selected.id && ["component","operation"].includes(n.kind));
  function inspect(entity: ApplicationNode) {
    setSelectedId(entity.id); setSelectedRelations([]);
    setNodes(previous=>previous.map(node=>({...node,selected:node.id===entity.id})));
  }
  function drill(entity: ApplicationNode) {
    inspect(entity);
    setFocus(entity.id);
    setDetail(entity.kind === "screen" ? "components" : "elements");
  }
  function evidenceLinks(evidence: MapEvidence[]) {
    return evidence.map(ref => <button type="button" className="text-button" key={ref.runId + "/" + ref.evidenceId}
      onClick={() => onEvidence(ref.runId, ref.evidenceId)}>#{ref.evidenceId} · {ref.runId.slice(0, 8)}</button>);
  }
  return <section className="application-map-page">
    <div className="page-heading"><h1>Application map</h1><p>Explore screens, reusable components, interactions and observed services.</p></div>
    <div className="application-toolbar">
      <label>Application<select aria-label="Map application" value={site} onChange={e => setSite(e.target.value)}>
        {sites.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Detail<select aria-label="Map detail" value={detail} onChange={e => setDetail(e.target.value)}>
        <option value="screens">Screens</option><option value="components">Components</option><option value="elements">Elements & operations</option>
      </select></label>
      <label className="checkbox-row"><input type="checkbox" checked={showRules} onChange={e => setShowRules(e.target.checked)} />Rules</label>
      <label className="checkbox-row"><input type="checkbox" checked={showServices} onChange={e => setShowServices(e.target.checked)} />Services</label>
      <button className="button secondary" type="button" onClick={() => { void instance?.fitView({ padding: 0.15, duration: 250 }); }}><Focus size={16} />Fit map</button>
    </div>
    {error && <p role="alert" className="alert error">{error}</p>}
    {!sites.length && !error ? <div className="panel"><p>Explore an application to start its map.</p></div> :
      !map ? <p role="status">Loading application map…</p> : <>
        <div className="application-map-meta">
          <span>{screens.length} screens · {map.nodes.filter(n => n.kind === "component" && n.shared).length} shared components · {map.nodes.filter(n => n.kind === "rule").length} rules · {map.nodes.filter(n => n.kind === "service").length} services</span>
          {focus && <button type="button" className="text-button" onClick={() => {setFocus(undefined);setDetail("screens");}}><ArrowUpLeft size={14} />All screens</button>}
          <span className="map-help">Double-click a screen to explore its contents</span>
        </div>
        <div className="application-workspace">
          <div ref={canvas} className="application-canvas" aria-label="Application graph">
            <ReactFlow<EntityNode, RelationEdge> nodes={nodes} edges={layout.edges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange} onInit={setInstance} colorMode={theme}
              onNodeClick={(_event, node) => inspect(node.data.entity)}
              onNodeDoubleClick={(_event, node) => drill(node.data.entity)}
              onEdgeClick={(_event, edge) => { setSelectedRelations(edge.data?.ids ?? []); setSelectedId(undefined); }}
              onPaneClick={() => { setSelectedId(undefined); setSelectedRelations([]); }}
              nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
              minZoom={0.05} maxZoom={2} fitView zoomOnDoubleClick={false}
              onlyRenderVisibleElements aria-label="Application structure graph">
              <Background gap={24} size={1} /><Controls showInteractive={false} />
              <MiniMap<EntityNode> pannable zoomable nodeColor={n => {
                const colors: Record<string,string> = { screen: "#6b9b87", component: "#9b85b9", service: "#c3945d" };
                return colors[n.data.entity.kind] ?? "#9aa3a0";
              }} />
            </ReactFlow>
            {!nodes.length && <p className="graph-empty">No entities match this view.</p>}
          </div>
          <aside className="application-inspector" aria-label="Entity details">
            {selected ? <>
              <div className="entity-kind">{selected.shared ? "Shared " : ""}{selected.kind}</div><h2>{selected.label}</h2>
              {selected.route && <p className="small mono">{selected.route}</p>}
              {selected.role && <p className="small muted">{selected.role} · {selected.status}</p>}
              {selected.kind === "component" && selected.shared && <p className="small muted">Observed in {selected.screenIds.length} screens. Grouped by visible boundary and role.</p>}
              {selected.kind !== "screen" && selected.screenIds.length > 0 && <><h3>Used in</h3>
                {screens.filter(screen => selected.screenIds.includes(screen.id)).map(screen => <button className="inspector-row" type="button" key={screen.id} onClick={()=>drill(screen)}><AppWindow size={14}/>{screen.label}</button>)}</>}
              {selected.description && <p className="entity-description">{selected.description}</p>}
              {selected.scope === "market-specific" && <p className="badge">Market-specific observation</p>}
              {selected.examples?.length ? <details><summary>Observed examples</summary><dl>{selected.examples.map((example,i) => <div key={i}><dt>{example.dimension}</dt><dd>{example.value}</dd></div>)}</dl></details> : null}
              {["screen","component","service"].includes(selected.kind) && <div className="inspector-actions"><button type="button" className="button secondary" onClick={() => drill(selected)}><Focus size={14} />Focus {selected.kind}</button>
                {selected.kind === "screen" && <button type="button" className="text-button" onClick={() => onExplore(site, selected.label)}>Explore pending paths</button>}</div>}
              {relatedEntities?.length ? <><h3>{selected.kind === "service" ? "Operations" : "Components"}</h3>{relatedEntities.map(entity=><button type="button" className="inspector-row" key={entity.id} onClick={()=>inspect(entity)}>{React.createElement(icons[entity.kind],{size:14})}{entity.label}</button>)}</> : null}
              {relatedRules?.length ? <><h3>Behavior rules</h3>{relatedRules.map(rule => <button type="button" className="inspector-row" key={rule.id} onClick={() => inspect(rule)}><GitBranch size={14} />{rule.label}</button>)}</> : null}
              {relatedControls?.length ? <><h3>Elements</h3>{relatedControls.map(control => <button type="button" className="inspector-row" key={control.id} onClick={() => inspect(control)}>
                <span className={"entity-state " + control.status} />{control.label}<small>{control.status}</small></button>)}</> : null}
              <h3>Evidence</h3><div className="graph-evidence">{refs.length ? evidenceLinks(refs) : <p className="small muted">Recorded from network metadata. No action association is available.</p>}</div>
            </> : relations.length ? <><h2>Connection</h2>{relations.map(relation => <div key={relation.id}><h3>{relation.label}</h3>
              <p>{map.nodes.find(n => n.id === relation.source)?.label} → {map.nodes.find(n => n.id === relation.target)?.label}</p>
              <p className="small muted">{relation.count} observations</p></div>)}<div className="graph-evidence">{evidenceLinks(refs)}</div></> : <>
              <h2>Explore the graph</h2><p className="small muted">Select an entity or connection to inspect its behavior and evidence.</p>
              <label className="entity-search"><Search size={14} /><input aria-label="Find map entity" placeholder="Find a screen or component" value={query} onChange={e => setQuery(e.target.value)} /></label>
              <div className="entity-browser">{map.nodes.filter(n => ["screen","component","service"].includes(n.kind) &&
                (!query || n.label.toLowerCase().includes(query.toLowerCase()))).map(entity => <button type="button" className="inspector-row" key={entity.id} onClick={() => inspect(entity)}>
                {React.createElement(icons[entity.kind], { size: 14 })}{entity.label}</button>)}</div>
              <h3>Pending alternatives</h3>
              {map.pending.length ? map.pending.map(entry => <button className="inspector-row" key={entry.screenId} type="button" onClick={() => {
                const entity = map.nodes.find(n => n.id === entry.screenId); if (entity) drill(entity);
              }}>{entry.screen}<small>{entry.controls.length} untried controls</small></button>) : <p className="small muted">No untried controls in the recorded snapshots.</p>}
            </>}
          </aside>
        </div>
        {(map.gaps.length > 0 || map.warnings.length > 0) && <details className="map-gaps"><summary>Coverage and open questions ({map.gaps.length + map.warnings.length})</summary>
          <ul>{[...map.warnings,...map.gaps].map((gap,i) => <li key={i}>{gap}</li>)}</ul></details>}
      </>}
  </section>;
}
