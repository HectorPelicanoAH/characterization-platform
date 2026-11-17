import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Controls, MiniMap, Handle, Position, useNodesState, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { AppWindow, Component, MousePointer2, Server, FileCode2, GitBranch, Focus, ArrowUpLeft, ArrowRight, Search, ChevronDown } from "lucide-react";
import type { ApplicationMap as MapData, ApplicationNode, MapEvidence } from "../shared/application-map";
import { applicationLayout, applicationConnections, type EntityNode, type RelationEdge } from "./application-layout";
import "@xyflow/react/dist/style.css";
import "./application-map.css";

const icons = { screen: AppWindow, component: Component, element: MousePointer2, service: Server, operation: FileCode2, rule: GitBranch };
const Entity = memo(function Entity({ data, selected }: NodeProps<EntityNode>) {
  const { entity, childCount } = data;
  const Icon = icons[entity.kind];
  return <div className={"application-entity " + entity.kind + (childCount ? " entity-container" : "") + (selected ? " selected" : "")}>
    <Handle id="in-left" type="target" position={Position.Left} isConnectable={false} />
    <Handle id="in-right" type="target" position={Position.Right} isConnectable={false} />
    <header><Icon size={16} /><div><small>{entity.shared && entity.kind === "component" ? "Shared component" : entity.kind}</small>
      <strong>{entity.label}</strong></div>
      {childCount > 0 && <span className="entity-child-count" title="Contained entities">{childCount}</span>}
      {entity.kind === "element" && <span title={entity.status} className={"entity-state " + entity.status} />}
    </header>
    {entity.kind === "screen" && childCount === 0 && <p>{data.ruleCount} recorded rules</p>}
    <Handle id="out-right" type="source" position={Position.Right} isConnectable={false} />
    <Handle id="out-left" type="source" position={Position.Left} isConnectable={false} />
  </div>;
});
const nodeTypes = { entity: Entity };
function fitCanvas(instance: ReactFlowInstance<EntityNode, RelationEdge> | undefined, nodes: EntityNode[], canvas: HTMLDivElement | null, duration = 200) {
  if (!instance || !canvas || !nodes.length) return;
  const roots = nodes.filter(node => !node.parentId);
  if (!roots.length) return;
  const left = Math.min(...roots.map(node => node.position.x)), top = Math.min(...roots.map(node => node.position.y));
  const width = Math.max(...roots.map(node => node.position.x + node.width!)) - left;
  const height = Math.max(...roots.map(node => node.position.y + node.height!)) - top;
  const availableHeight = canvas.clientHeight - 48;
  const zoom = Math.min(1, canvas.clientWidth / (width + 64), availableHeight / (height + 64));
  void instance.setViewport({ x: (canvas.clientWidth - width * zoom) / 2 - left * zoom, y: (availableHeight - height * zoom) / 2 - top * zoom, zoom }, { duration });
}

export function ApplicationMap({ initialSite, onEvidence, onExplore }: {
  initialSite?: string;
  onEvidence: (runId: string, evidenceId: number) => void;
  onExplore: (site: string, screen: string) => void;
}) {
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState(initialSite ?? "");
  const [map, setMap] = useState<MapData>();
  const [error, setError] = useState("");
  const [detail, setDetail] = useState("elements");
  const [showRules, setShowRules] = useState(true);
  const [showServices, setShowServices] = useState(true);
  const [focus, setFocus] = useState<string>();
  const [screenId, setScreenId] = useState("");
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
      frame = requestAnimationFrame(() => {
        fitCanvas(instance, instance.getNodes(), canvas.current, 150);
      });
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
    setScreenId("");
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
    setSelectedId(previous => layout.nodes.some(node => node.id === previous) ? previous : undefined);
    setSelectedRelations([]);
  }, [layout]);
  useEffect(() => {
    setNodes(layout.nodes);
    let attempts = 0, frame: number;
    function fit() {
      const current = instance?.getNodes() ?? [];
      const ready = current.length === layout.nodes.length && layout.nodes.every(node => {
        const actual = current.find(value => value.id === node.id);
        return actual && actual.position.x === node.position.x && actual.position.y === node.position.y && actual.width === node.width;
      });
      if (!ready && attempts++ < 20) { frame = requestAnimationFrame(fit); return; }
      fitCanvas(instance, layout.nodes, canvas.current);
    }
    frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [layout, setNodes, instance]);
  useEffect(() => {
    setNodes(previous => previous.map(node => ({ ...node, selected: node.id === selectedId })));
  }, [selectedId, layout, setNodes]);
  const connections = useMemo(() => map ? applicationConnections(map, layout, selectedId) : [], [map, layout, selectedId]);
  const selected = !selectedRelations.length ? map?.nodes.find(n => n.id === selectedId) : undefined;
  const relations = map?.edges.filter(edge => selectedRelations.includes(edge.id)) ?? [];
  const refs = selected?.evidence ?? [...new Map(relations.flatMap(r => r.evidence).map(ref => [ref.runId + "/" + ref.evidenceId, ref])).values()];
  const screens = useMemo(() => map?.nodes.filter(n => n.kind === "screen").sort((a,b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) ?? [], [map]);
  const relatedRules = selected && map?.nodes.filter(n => n.kind === "rule" &&
    (selected.kind === "screen" ? n.screenIds.includes(selected.id) : n.parentId === selected.id));
  const relatedControls = selected && map?.nodes.filter(n => n.kind === "element" &&
    (selected.kind === "screen" ? n.screenIds.includes(selected.id) : n.parentId === selected.id));
  const relatedEntities = selected && map?.nodes.filter(n =>
    selected.kind === "screen" ? n.kind === "component" && n.screenIds.includes(selected.id) :
      n.parentId === selected.id && ["component","operation"].includes(n.kind));
  function inspect(entity: ApplicationNode) {
    if (["service", "operation"].includes(entity.kind)) setShowServices(true);
    if (entity.kind === "rule") setShowRules(true);
    if (!layout.nodes.some(node => node.id === entity.id)) {
      setFocus(undefined);
      setScreenId("");
      setDetail(entity.kind === "screen" ? "screens" : entity.kind === "component" ? "components" : "elements");
    }
    setSelectedId(entity.id); setSelectedRelations([]); setQuery("");
  }
  function drill(entity: ApplicationNode) {
    inspect(entity);
    setFocus(entity.id);
    setScreenId(entity.kind === "screen" ? entity.id : entity.screenIds.includes(screenId) ? screenId : entity.screenIds.length === 1 ? entity.screenIds[0] : "");
    setDetail(entity.kind === "screen" ? "components" : "elements");
  }
  function chooseScreen(id: string) {
    setScreenId(id); setFocus(id || undefined); setSelectedId(id || undefined); setSelectedRelations([]); setQuery("");
  }
  function evidenceLinks(evidence: MapEvidence[]) {
    return evidence.map(ref => <button type="button" className="text-button" key={ref.runId + "/" + ref.evidenceId}
      onClick={() => onEvidence(ref.runId, ref.evidenceId)}>#{ref.evidenceId} · {ref.runId.slice(0, 8)}</button>);
  }
  return <section className="application-map-page">
    <div className="page-heading"><h1>Application map</h1><p>Explore the whole application, or choose a screen to see its structure.</p></div>
    <div className="application-toolbar">
      <label className="map-select-field">Application<span className="map-select-control"><select aria-label="Map application" value={sites.length ? site : ""} disabled={!sites.length} onChange={e => setSite(e.target.value)}>
        {!sites.length && <option value="">No applications yet</option>}
        {sites.map(value => <option key={value}>{value}</option>)}
      </select><ChevronDown size={16} aria-hidden="true" /></span></label>
      <label className="map-select-field">Screen<span className="map-select-control"><select aria-label="Map screen" value={screenId} disabled={!screens.length} onChange={e => chooseScreen(e.target.value)}>
        <option value="">All screens</option>
        {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.label}{screens.filter(other => other.label === screen.label).length > 1 ? " · " + (screen.route ?? screen.id.slice(-6)) : ""}</option>)}
      </select><ChevronDown size={16} aria-hidden="true" /></span></label>
      <label className="map-select-field">Detail<span className="map-select-control"><select aria-label="Map detail" value={detail} disabled={!sites.length} onChange={e => setDetail(e.target.value)}>
        <option value="screens">Screens</option><option value="components">Components</option><option value="elements">All entities</option>
      </select><ChevronDown size={16} aria-hidden="true" /></span></label>
      <div className="map-toggle-group">
        <label className="map-toggle"><input type="checkbox" disabled={!sites.length} checked={showRules} onChange={e => setShowRules(e.target.checked)} />Rules</label>
        <label className="map-toggle"><input type="checkbox" disabled={!sites.length} checked={showServices} onChange={e => setShowServices(e.target.checked)} />Services</label>
      </div>
      <button className="button secondary" type="button" disabled={!nodes.length} onClick={() => fitCanvas(instance, nodes, canvas.current)}><Focus size={16} />Fit map</button>
    </div>
    {error && <p role="alert" className="alert error">{error}</p>}
    {!sites.length && !error ? <div className="panel"><p>Explore an application to start its map.</p></div> :
      !map ? <p role="status">Loading application map…</p> : <>
        <div className="application-map-meta">
          <span>{screens.length} screens · {map.nodes.filter(n => n.kind === "component" && n.shared).length} shared components · {map.nodes.filter(n => n.kind === "rule").length} rules · {map.nodes.filter(n => n.kind === "service").length} services</span>
          {focus && <button type="button" className="text-button" onClick={() => chooseScreen("")}><ArrowUpLeft size={14} />All screens</button>}
          <span className="map-help">Double-click a screen to explore its contents</span>
        </div>
        <div className="application-workspace">
          <div ref={canvas} className="application-canvas" aria-label="Application graph">
            <ReactFlow<EntityNode, RelationEdge> nodes={nodes} edges={layout.edges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange} onInit={setInstance} colorMode={theme}
              onKeyDown={event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                const target = event.target as Element;
                const node = target.closest<HTMLElement>(".react-flow__node");
                const edge = target.closest<SVGGElement>(".react-flow__edge");
                if (target !== node && target !== edge) return;
                event.preventDefault();
                if (node) { const entity = map.nodes.find(entity => entity.id === node.dataset.id); if (entity) inspect(entity); }
                else if (edge) setSelectedRelations(layout.edges.find(relation => relation.id === edge.dataset.id)?.data?.ids ?? []);
              }}
              onNodeClick={(_event, node) => inspect(node.data.entity)}
              onNodeDoubleClick={(_event, node) => drill(node.data.entity)}
              onEdgeClick={(_event, edge) => { setSelectedRelations(edge.data?.ids ?? []); }}
              onPaneClick={() => { setSelectedId(undefined); setSelectedRelations([]); }}
              nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
              minZoom={0.001} maxZoom={2} zoomOnDoubleClick={false}
              onlyRenderVisibleElements aria-label="Application structure graph">
              <Controls showInteractive={false} showFitView={false} />
              <MiniMap<EntityNode> pannable zoomable ariaLabel="Map overview" nodeColor={node => node.selected ? "#b6b2ff" : node.data.entity.kind === "service" ? "#a99b83" : node.data.entity.kind === "screen" ? "#8a899e" : "#656b78"} />
            </ReactFlow>
            {!nodes.length && <p className="graph-empty">No entities match this view.</p>}
            {nodes.length > 0 && <div className="graph-caption"><span>{focus ? "Screen detail" : "Application overview"}</span>
              <span>{layout.nodes.length} entities · {layout.edges.length} connections</span></div>}
          </div>
          <aside className="application-inspector" aria-label="Entity details">
            <div className="entity-picker">
              <label className="entity-search"><Search size={14} /><input aria-label="Find map entity" placeholder="Screen, component or service" value={query} onChange={e => setQuery(e.target.value)} /></label>
              {query && <div className="entity-browser" aria-label="Matching entities">{map.nodes.filter(n => n.label.toLowerCase().includes(query.toLowerCase())).map(entity => <button type="button" className="inspector-row" key={entity.id} onClick={() => inspect(entity)}>
                {React.createElement(icons[entity.kind], { size: 14 })}{entity.label}</button>)}</div>
              }
            </div>
            {selected ? <>
              <div className="entity-kind">{selected.shared ? "Shared " : ""}{selected.kind}</div><h2>{selected.label}</h2>
              {selected.kind === "screen" && <p className="small muted">{map.nodes.filter(n => n.kind === "rule" && n.screenIds.includes(selected.id)).length} recorded rules</p>}
              <details className="inspector-section" open><summary>Direct connections ({connections.length})</summary>
                {connections.length ? connections.map(connection => {
                  const other = map.nodes.find(node => node.id === (connection.source === selected.id ? connection.target : connection.source));
                  return other && <button className="inspector-row connection-row" type="button" key={connection.id} onClick={() => inspect(other)}>
                    <ArrowRight size={14} className={connection.target === selected.id ? "connection-incoming" : undefined} />
                    <span>{other.label}<small>{connection.source === selected.id ? "Outgoing" : "Incoming"} · {connection.label}</small></span></button>;
                }) : <p className="small muted">No direct connections recorded at this detail level.</p>}
              </details>
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
              {relatedEntities?.length ? <details className="inspector-section"><summary>{selected.kind === "service" ? "Operations" : "Components"} ({relatedEntities.length})</summary>{relatedEntities.map(entity=><button type="button" className="inspector-row" key={entity.id} onClick={()=>inspect(entity)}>{React.createElement(icons[entity.kind],{size:14})}{entity.label}</button>)}</details> : null}
              {relatedRules?.length ? <details className="inspector-section" open><summary>Behavior rules ({relatedRules.length})</summary>{relatedRules.map(rule => <button type="button" className="inspector-row" key={rule.id} onClick={() => inspect(rule)}><GitBranch size={14} />{rule.label}</button>)}</details> : null}
              {relatedControls?.length ? <details className="inspector-section"><summary>Elements ({relatedControls.length})</summary>{relatedControls.map(control => <button type="button" className="inspector-row" key={control.id} onClick={() => inspect(control)}>
                <span className={"entity-state " + control.status} />{control.label}<small>{control.status}</small></button>)}</details> : null}
              <h3>Evidence</h3><div className="graph-evidence">{refs.length ? evidenceLinks(refs) : <p className="small muted">Recorded from network metadata. No action association is available.</p>}</div>
            </> : relations.length ? <><h2>Connection</h2>{relations.map(relation => <div key={relation.id}><h3>{relation.label}</h3>
              <p>{map.nodes.find(n => n.id === relation.source)?.label} → {map.nodes.find(n => n.id === relation.target)?.label}</p>
              <p className="small muted">{relation.count} observations</p></div>)}<div className="graph-evidence">{evidenceLinks(refs)}</div></> : <>
              <h2>Explore the graph</h2><p className="small muted">Select an entity or connection to inspect its behavior and evidence.</p>
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
