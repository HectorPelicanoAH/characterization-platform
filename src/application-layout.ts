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
    if (!showServices && ["service", "operation"].includes(node.kind)) return false;
    if (!showRules && node.kind === "rule") return false;
    if (detail === "screens" && !["screen", "service"].includes(node.kind)) return false;
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
  function measure(entity: ApplicationNode) {
    const nested = children.get(entity.id) ?? [];
    if (!nested.length) {
      const size = { width: entity.kind === "screen" ? 360 : 250, height: entity.kind === "screen" ? 116 : 72 };
      sizes.set(entity.id, size);
      return size;
    }
    const childSizes = nested.map(child => measure(child));
    const flat = nested.every(child => !(children.get(child.id)?.length));
    const columns = flat && nested.length > 8 ? nested.length > 30 ? 4 : 2 : 1;
    const columnWidth = Math.max(...childSizes.map(size => size.width));
    const rowHeight = Math.max(...childSizes.map(size => size.height)) + 12;
    let y = 76;
    nested.forEach((child,index) => {
      if (columns === 1) {
        positions.set(child.id, { x: 20, y });
        y += childSizes[index].height + 12;
      } else positions.set(child.id, { x: 20 + (index % columns) * (columnWidth + 12), y: 76 + Math.floor(index / columns) * rowHeight });
    });
    if (columns > 1) y = 76 + Math.ceil(nested.length / columns) * rowHeight;
    const width = Math.max(entity.kind === "screen" ? 420 : 290, columns * (columnWidth + 12) + 28);
    const size = { width, height: y + 8 };
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
    let y = 0;
    const columns = lane[0].kind === "screen" && lane.length > 3 ? 2 : 1;
    const width = Math.max(...lane.map(n => sizes.get(n.id)!.width));
    const columnY = [0, 0];
    lane.forEach((entity, index) => {
      const column = index % columns;
      y = columnY[column];
      positions.set(entity.id, { x: x + column * (width + 150), y });
      columnY[column] = y + sizes.get(entity.id)!.height + 110;
    });
    x += columns * (width + 150) + 90;
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
  const colors: Record<string, string> = { navigates: "#608fce", uses: "#a487c8", calls: "#c38942" };
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
