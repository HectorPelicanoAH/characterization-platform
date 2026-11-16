import { z } from "zod";

export const discoverySchema = z.object({
  capabilityKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  capability: z.string().min(1).max(160),
  component: z.string().max(160).default(""),
  given: z.string().min(1).max(600),
  action: z.string().min(1).max(600),
  observed: z.string().min(1).max(1600),
  scope: z.enum(["observed", "market-specific"]).default("observed"),
  examples: z.array(z.object({
    dimension: z.string().max(100),
    value: z.string().max(240),
  })).max(12).default([]),
  evidenceIds: z.array(z.number().int().positive()).min(1).max(30),
  screenEvidenceId: z.number().int().positive(),
});
export type Discovery = z.infer<typeof discoverySchema>;
export type RecordedDiscovery = Discovery & { id: string; at: string; screenEvidenceIds?: number[] };
