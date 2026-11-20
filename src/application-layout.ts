import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { ApplicationMap, ApplicationNode } from "../shared/application-map";

export type EntityData = { entity: ApplicationNode; childCount: number; ruleCount: number } & Record<string, unknown>;
export type EntityNode = Node<EntityData, "entity">;
export type RelationEdge = Edge<{ ids: string[] }, "smoothstep">;

export function applicationLayout(map: ApplicationMap, detail: string, showRules: boolean, showServices: boolean, focus?: string) {
  const all = new Map(map.nodes.map(node => [node.id, node]));
  const focusNode = focus ? all.get(focus) : undefined;
  const screenIds = focusNode?.kind === "screen" ? [focusNode.id] : focusNode?.screenIds ?? [];
  const focusedEntities = new Set<string>();
  if (focusNode && focusNode.kind !== "screen") {
    function descend(id: string) {
      if (focusedEntities.has(id)) return;
      focusedEntities.add(id);
      for (const child of map.nodes.filter(node => node.parentId === id)) descend(child.id);
    }
    descend(focusNode.id);
    for (const edge of map.edges.filter(edge => focusedEntities.has(edge.source) && edge.kind === "calls")) {
      focusedEntities.add(edge.target);
      const service = all.get(edge.target)?.parentId;
      if (service) focusedEntities.add(service);
    }
  }
  const neighbors = new Set<string>();
  if (screenIds.length) {
    for (const edge of map.edges.filter(edge => edge.kind === "navigates")) {
      if (edge.contextScreenId && screenIds.includes(edge.contextScreenId)) neighbors.add(edge.target);
      if (screenIds.includes(edge.target) && edge.contextScreenId) neighbors.add(edge.contextScreenId);
    }
  }
  const included = map.nodes.filter(node => {
    // The "services" detail level shows only services and their operations, regardless of the Rules/Services toggles.
    if (detail === "services" && !["service", "operation"].includes(node.kind)) return false;
    if (detail !== "services" && !showServices && ["service", "operation"].includes(node.kind)) return false;
    if (!showRules && node.kind === "rule") return false;
    if (detail === "screens" && !["screen", "service", ...(showRules ? ["rule"] : [])].includes(node.kind)) return false;
    if (detail === "components" && ["element", "operation"].includes(node.kind)) return false;
    if (focusNode && focusNode.kind !== "screen")
      return focusedEntities.has(node.id) || (node.kind === "screen" && (screenIds.includes(node.id) || neighbors.has(node.id)));
    return !screenIds.length || node.screenIds.some(id => screenIds.includes(id)) || (node.kind === "screen" && neighbors.has(node.id));
  });
  const visible = new Map(included.map(node => [node.id, node]));
  function visibleParent(entity: ApplicationNode): string | undefined {
    let parent = entity.parentId;
    while (parent && !visible.has(parent)) parent = all.get(parent)?.parentId;
    return parent;
  }
  const children = new Map<string, ApplicationNode[]>();
  const roots: ApplicationNode[] = [];
  for (const entity of included) {
    const parent = visibleParent(entity);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), entity]);
    else roots.push(entity);
  }
  const sizes = new Map<string, { width: number; height: number }>();
  const positions = new Map<string, { x: number; y: number }>();
  function pack(entities: ApplicationNode[], gap: number, padding: number, header: number) {
    const columnWidth = Math.max(...entities.map(entity => sizes.get(entity.id)!.width));
    let best: { width: number; height: number; score: number; placements: Map<string, { x: number; y: number }> } | undefined;
    for (let columns = 1; columns <= Math.min(6, entities.length); columns++) {
      const heights = Array<number>(columns).fill(header), placements = new Map<string, { x: number; y: number }>();
      for (const entity of entities) {
        const column = heights.indexOf(Math.min(...heights));
        placements.set(entity.id, { x: padding + column * (columnWidth + gap), y: heights[column] });
        heights[column] += sizes.get(entity.id)!.height + gap;
      }
      const width = padding * 2 + columns * columnWidth + (columns - 1) * gap;
      const height = Math.max(...heights) - gap + padding;
      const score = Math.abs(Math.log(width / height / 1.3));
      if (!best || score < best.score) best = { width, height, score, placements };
    }
    return best!;
  }
  function measure(entity: ApplicationNode) {
    const nested = children.get(entity.id) ?? [];
    if (!nested.length) {
      const size = { width: entity.kind === "screen" ? 360 : 250, height: entity.kind === "screen" ? 116 : 96 };
      sizes.set(entity.id, size);
      return size;
    }
    nested.forEach(child => measure(child));
    const packed = pack(nested, 16, 20, 80);
    for (const [id, position] of packed.placements) positions.set(id, position);
    const size = { width: Math.max(entity.kind === "screen" ? 420 : 290, packed.width), height: packed.height };
    sizes.set(entity.id, size);
    return size;
  }
  for (const root of roots) measure(root);
  const lanes = [
    roots.filter(n => n.kind === "component"),
    roots.filter(n => n.kind === "screen"),
    roots.filter(n => n.kind === "service"),
    roots.filter(n => !["screen", "component", "service"].includes(n.kind)),
  ];
  let x = 0;
  for (const lane of lanes) {
    if (!lane.length) continue;
    const packed = pack(lane, 110, 0, 0);
    for (const [id, position] of packed.placements) positions.set(id, { x: position.x + x, y: position.y });
    x += packed.width + 180;
  }
  const nodes: EntityNode[] = [];
  function append(entity: ApplicationNode) {
    const nested = children.get(entity.id) ?? [];
    const parentId = visibleParent(entity);
    const size = sizes.get(entity.id)!;
    nodes.push({
      id: entity.id, type: "entity", position: positions.get(entity.id) ?? { x: 0, y: 0 },
      parentId, ...(parentId ? { extent: "parent" as const } : {}),
      style: { width: size.width, height: size.height }, width: size.width, height: size.height,
      data: { entity, childCount: nested.length, ruleCount: map.nodes.filter(n => n.kind === "rule" && n.screenIds.some(id => entity.screenIds.includes(id))).length },
      ariaLabel: entity.kind + " " + entity.label, focusable: true,
    });
    for (const child of nested) append(child);
  }
  for (const root of roots) append(root);
  function ancestor(id: string, contextScreenId?: string): string | undefined {
    let entity = all.get(id);
    while (entity && !visible.has(entity.id)) entity = all.get(entity.parentId ?? "");
    return entity?.id ?? (contextScreenId && visible.has(contextScreenId) ? contextScreenId : undefined);
  }
  const colors: Record<string, string> = { navigates: "var(--map-accent)", uses: "#978cae", calls: "#b29d7c", explains: "#829db5" };
  const relations = new Map<string, RelationEdge>();
  for (const relation of map.edges) {
    if (relation.kind === "contains") continue;
    const source = ancestor(relation.source, relation.contextScreenId), target = ancestor(relation.target);
    if (!source || !target || source === target) continue;
    if (visibleParent(visible.get(target)!) === source) continue;
    if (relation.kind === "uses") {
      const parent = all.get(visibleParent(visible.get(target)!) ?? "");
      if (parent?.kind === "component" && parent.screenIds.includes(source)) continue;
    }
    const id = [source, target, relation.kind].join("/");
    const previous = relations.get(id);
    if (previous) previous.data!.ids.push(relation.id);
    else {
      function absoluteX(entityId: string): number {
        const parentId = visibleParent(visible.get(entityId)!);
        return (positions.get(entityId)?.x ?? 0) + (parentId ? absoluteX(parentId) : 0);
      }
      const backwards = absoluteX(target) < absoluteX(source);
      relations.set(id, {
      id, source, target, type: "smoothstep", label: relation.kind === "navigates" ? "Navigates" : relation.label,
      sourceHandle: backwards ? "out-left" : "out-right", targetHandle: backwards ? "in-right" : "in-left",
      data: { ids: [relation.id] }, style: { stroke: colors[relation.kind] ?? "#999", strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: colors[relation.kind] ?? "#999" },
      ariaLabel: relation.label + " from " + visible.get(source)?.label + " to " + visible.get(target)?.label,
      });
    }
  }
  return { nodes, edges: [...relations.values()] };
}

/** Inspector relations never determine which entities appear in the graph. */
export function applicationConnections(map: ApplicationMap, layout: { nodes: EntityNode[]; edges: RelationEdge[] }, selectedId?: string) {
  if (!selectedId) return [];
  const visible = new Set(layout.nodes.map(node => node.id));
  const connections = layout.edges.filter(edge => edge.source === selectedId || edge.target === selectedId);
  for (const edge of map.edges) {
    if (edge.kind !== "contains" || !visible.has(edge.source) || !visible.has(edge.target)) continue;
    if (edge.source === selectedId || edge.target === selectedId)
      connections.push({ id: edge.id, source: edge.source, target: edge.target, label: "Contains", data: { ids: [edge.id] } });
  }
  return connections;
}
