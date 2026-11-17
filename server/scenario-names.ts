import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const scenarioTitleSchema = z.string().trim().min(1).max(96).refine(value => !/[\r\n]/.test(value), "Use a short, single-line scenario title.");
export const renameScenariosSchema = z.object({ changes: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), title: scenarioTitleSchema })).min(1).max(80) });
export type ScenarioName = { key: string; title: string; gherkin: string };
export type ScenarioNames = Record<string, { title: string; updatedAt: string }>;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");

export function scenarioNameKey(origin: string, gherkin: string) {
  // Names identify business clauses, independent of titles, evidence IDs and sample rows.
  const clauses = gherkin.split("\n").filter(line => /^\s*(?:Given|When|Then|And|But)\s/.test(line)).map(normalize);
  return createHash("sha256").update(JSON.stringify([new URL(origin).origin, clauses])).digest("hex");
}
export function readScenarioNames(path: string): ScenarioNames {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
export function renameGherkin(gherkin: string, title: string) {
  return gherkin.replace(/^(Scenario(?: Outline)?:) [^\n]*/, (_match, keyword: string) => keyword + " " + title);
}
export function assertScenarioNames(catalog: ScenarioName[], changedKeys: Set<string>) {
  for (const candidate of catalog.filter(entry => changedKeys.has(entry.key))) {
    scenarioTitleSchema.parse(candidate.title);
    const conflict = catalog.find(entry => entry.key !== candidate.key && normalize(entry.title) === normalize(candidate.title));
    if (conflict) throw Error(`The title “${candidate.title}” already describes a different behavior (${conflict.key}). Choose concise titles that distinguish the action, result or condition; rename the earlier scenario too if its title is too broad. Existing scenario:\n${conflict.gherkin}`);
    if (catalog.some(entry => entry.key === candidate.key && normalize(entry.title) !== normalize(candidate.title)))
      throw Error("The same behavior must use one consistent scenario title.");
  }
}
export function saveScenarioNames(path: string, catalog: ScenarioName[], changes: { key: string; title: string }[]) {
  const unique = new Set(changes.map(change => change.key));
  if (unique.size !== changes.length || changes.some(change => !catalog.some(entry => entry.key === change.key))) throw Error("Rename only known scenarios, once per behavior.");
  const names = readScenarioNames(path);
  const revised = catalog.map(entry => ({ ...entry, title: changes.find(change => change.key === entry.key)?.title ?? names[entry.key]?.title ?? entry.title }));
  assertScenarioNames(revised, unique);
  for (const change of changes) names[change.key] = { title: scenarioTitleSchema.parse(change.title), updatedAt: new Date().toISOString() };
  writeFileSync(path + ".tmp", JSON.stringify(names, null, 2), { mode: 0o600 });
  renameSync(path + ".tmp", path);
  return revised;
}
