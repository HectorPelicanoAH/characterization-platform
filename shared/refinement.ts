import { z } from "zod";
import { scenarioTextSchema } from "./scenario.ts";

export const refinementResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  questions: z.array(z.string().min(1).max(1000)).max(5),
  changes: z.array(z.object({
    target: z.string().min(1).max(110),
    reason: z.string().min(1).max(1000),
    scenario: scenarioTextSchema,
  })).max(30),
});
export type RefinementResult = z.infer<typeof refinementResultSchema>;
export type RefinementJob = {
  id: string;
  status: "running" | "questions" | "ready" | "failed" | "saved";
  summary: string;
  questions: string[];
  error?: string;
  changes: { target: string; title: string; reason: string; before: string; after: string; selected: boolean; observations: number }[];
};
