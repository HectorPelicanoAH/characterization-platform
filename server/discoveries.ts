import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverySchema, type RecordedDiscovery } from "../shared/discovery.ts";
import type { Evidence } from "../shared/model.ts";
import { pageUrlFromResult } from "./domain.mjs";

export function readDiscoveries(dir: string, evidence: Evidence[]): RecordedDiscovery[] {
  const file = join(dir, "discoveries.jsonl");
  if (!existsSync(file) || statSync(file).size > 4 * 1024 * 1024) return [];
  const successful = new Map(evidence.filter(event => event.ok).map(event => [event.id, event]));
  const found = new Map<string, RecordedDiscovery>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const raw = JSON.parse(line);
      const parsed = discoverySchema.safeParse(raw);
      if (!parsed.success || typeof raw.id !== "string" || typeof raw.at !== "string") continue;
      const discovery = parsed.data;
      if (discovery.evidenceIds.some(id => !successful.has(id))) continue;
      const screen = successful.get(discovery.screenEvidenceId);
      if (!screen || !pageUrlFromResult(screen.detail)) continue;
      const screenEvidenceIds = Array.isArray(raw.screenEvidenceIds) ? raw.screenEvidenceIds.filter((id: unknown) =>
        typeof id === "number" && pageUrlFromResult(successful.get(id)?.detail ?? "")) : [discovery.screenEvidenceId];
      found.set(raw.id, { ...discovery, id: raw.id, at: raw.at, screenEvidenceIds });
    } catch { /* Retain complete discoveries after interrupted writes. */ }
  }
  return [...found.values()];
}
