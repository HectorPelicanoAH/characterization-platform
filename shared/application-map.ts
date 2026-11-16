export type MapEvidence = { runId: string; evidenceId: number };
export type ApplicationNodeKind = "screen" | "component" | "element" | "service" | "operation" | "rule";
export type ApplicationNode = {
  id: string;
  kind: ApplicationNodeKind;
  label: string;
  parentId?: string;
  shared: boolean;
  screenIds: string[];
  role?: string;
  route?: string;
  description?: string;
  scope?: "observed" | "market-specific";
  examples?: { dimension: string; value: string }[];
  status: "observed" | "exercised" | "blocked" | "pending";
  evidence: MapEvidence[];
};
export type ApplicationEdge = {
  id: string;
  source: string;
  target: string;
  kind: "contains" | "uses" | "navigates" | "calls" | "explains";
  label: string;
  evidence: MapEvidence[];
  count: number;
  contextScreenId?: string;
};
export type ApplicationMap = {
  site: string;
  nodes: ApplicationNode[];
  edges: ApplicationEdge[];
  pending: { screenId: string; screen: string; controls: string[] }[];
  gaps: string[];
  warnings: string[];
  runIds: string[];
};
