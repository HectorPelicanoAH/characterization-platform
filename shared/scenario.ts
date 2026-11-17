import { z } from "zod";

const clause = z.string().trim().min(1).max(2000).refine(value => !/[\r\n]/.test(value), "Use one line per clause.");
export const parametersSchema = z.object({
  columns: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(12),
  rows: z.array(z.array(z.string().max(240).refine(value => !/[\r\n|]/.test(value)))).min(1).max(20),
});
export const scenarioTextSchema = z.object({
  title: clause,
  given: z.array(clause).min(1).max(6),
  when: z.array(clause).min(1).max(3),
  then: z.array(clause).min(1).max(6),
  parameters: parametersSchema.nullable(),
});
export type ScenarioText = z.infer<typeof scenarioTextSchema>;
export type Parameters = z.infer<typeof parametersSchema>;

export function validateScenario(text: ScenarioText) {
  const clauses = [...text.given, ...text.when, ...text.then].join(" ");
  const placeholders = [...new Set(Array.from(clauses.matchAll(/<([^<>]+)>/g), match => match[1]))];
  const columns = text.parameters?.columns ?? [];
  if (columns.length !== new Set(columns).size || columns.some(column => !placeholders.includes(column)) ||
      placeholders.some(name => !columns.includes(name)) || text.parameters?.rows.some(row => row.length !== columns.length))
    throw Error("Each scenario parameter needs a unique Examples column and an observed value in every row.");
}

export function renderScenario(text: ScenarioText) {
  validateScenario(text);
  const clauses = (keyword: string, values: string[]) => values.map((value, index) => "  " + (index ? "And" : keyword) + " " + value.replace(/\s+/g, " ").trim());
  return [
    (text.parameters ? "Scenario Outline: " : "Scenario: ") + text.title.replace(/\s+/g, " ").trim(),
    ...clauses("Given", text.given), ...clauses("When", text.when), ...clauses("Then", text.then),
    ...(text.parameters ? ["", "  Examples:", ...[text.parameters.columns, ...text.parameters.rows].map(row => "    | " + row.join(" | ") + " |")] : []),
  ].join("\n");
}

export const scenarioGuidance = `Write scenario titles and ALL business clauses in English, including record_discovery. Translate UI labels into business intentions; keep original localized copy only in evidence, test locators or Examples when copy itself is under test. One scenario describes one rule and one observable outcome. Avoid incidental page inventory, literal button labels, products, URLs and marketing copy. Split unrelated outcomes. Distinguish rules, observed examples and unanswered questions. Do not turn a sampled behavior into a universal claim. Parameterize data that drives a rule with <snake_case> placeholders and a parameters table (columns and observed rows); render as Scenario Outline with Examples. Use reusable relationships for incidental data instead of adding unnecessary parameters. Never invent example rows, thresholds, rules or assertions. Preserve market scope, meaningful boundaries and external redirect behavior. For example: Given the bag contains one line; When the user removes that line; Then the bag is empty. Account links and recommendations belong to separate scenarios only when they represent a distinct observed rule.`;

export const scenarioNamingGuidance = `Use short, distinctive scenario titles, usually 4–10 words and at most 96 characters. Name the action and observable outcome, adding the condition that distinguishes similar cases. A capability label is not a scenario title: prefer "Increase bag quantity and recalculate totals" and "Decrease bag quantity and recalculate totals" over two scenarios called "Bag quantity". Review existing scenarios in the application before naming a new behavior. Reuse the title for the same behavior; different behaviors must have distinguishable titles. When a new case makes an older title too broad, rename both cases to coexist clearly. Avoid numbers, hashes, sample values and long paraphrases of the steps as disambiguation. Keep capabilityKey as the stable grouping concept; capability is the specific scenario title.`;
