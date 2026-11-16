import { z } from "zod";
import type { RecordedDiscovery } from "./discovery.ts";

export const providers = ["codex", "claude", "copilot"] as const;
export type Provider = (typeof providers)[number];
export const scopes = {
  smoke: {
    label: "Smoke",
    description: "Entry points and main flows",
    calls: 30,
    minutes: 8,
    flows: "3–5",
  },
  standard: {
    label: "Functional",
    description: "Navigation and common journeys",
    calls: 80,
    minutes: 20,
    flows: "6–12",
  },
  deep: {
    label: "Detailed",
    description: "Variations, states and validation",
    calls: 160,
    minutes: 40,
    flows: "12–25",
  },
  exhaustive: {
    label: "Exhaustive",
    description: "Edge cases and alternative paths",
    calls: 280,
    minutes: 60,
    flows: "25+",
  },
} as const;
export const settingsSchema = z.object({
  context: z.string().max(30000).default(""),
  directories: z.array(z.string().min(1).max(4096)).max(12).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;
export const runInputSchema = z.object({
  url: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    }, "Use an HTTP(S) URL without embedded credentials."),
  provider: z.enum(providers),
  model: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9._:/-]*$/)
    .default(""),
  effort: z
    .enum(["default", "low", "medium", "high", "xhigh"])
    .default("default"),
  scope: z
    .enum(["smoke", "standard", "deep", "exhaustive"])
    .default("standard"),
  prompt: z.string().max(30000).default(""),
  headed: z.boolean().default(true),
  serviceMapEnabled: z.boolean().default(false),
  prioritizeNewPaths: z.boolean().default(true),
});
export type RunInput = z.infer<typeof runInputSchema>;
export const reportSchema = z.object({
  summary: z.string().min(1).max(12000),
  flows: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        given: z.string().max(500).default(""),
        steps: z.array(z.string().max(2000)).min(1).max(60),
        observed: z.string().min(1).max(8000),
        evidenceIds: z.array(z.number().int().positive()).min(1).max(100),
        testCode: z.string().min(1).max(40000),
      }),
    )
    .max(160),
  decisions: z.array(z.object({
    condition: z.string().min(1).max(240),
    action: z.string().min(1).max(240),
    outcome: z.string().min(1).max(600),
    sourceEvidenceId: z.number().int().positive(),
    resultEvidenceId: z.number().int().positive(),
  })).max(120).default([]),
  gaps: z.array(z.string().max(3000)).max(100),
});
export type Report = z.infer<typeof reportSchema>;
export type Account = {
  id: Provider;
  installed: boolean;
  connected: boolean;
  version?: string;
  message?: string;
  login?: { status: string; output: string; url?: string; prompt?: { message: string; choices: { value: string; label: string }[] } };
};
export type ContextFile = { path: string; content: string; hash: string };
export type ContextSnapshot = {
  files: ContextFile[];
  warnings: string[];
  characters: number;
};
export type Evidence = {
  id: number;
  tool: string;
  at: string;
  ok: boolean;
  detail: string;
  element?: string;
  externalUrl?: string;
  externalUrls?: string[];
  startedAt?: string;
  finishedAt?: string;
};
export type Run = RunInput & {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  phase: string;
  error?: string;
  report?: Report;
  contextFiles: string[];
  warnings: string[];
  evidence: Evidence[];
  logs: string[];
  serviceMapState?: ServiceMapState;
  lastProviderActivityAt?: string;
  discoveries?: RecordedDiscovery[];
};

export type ServiceMapState = "disabled" | "pending" | "ready" | "partial" | "unavailable";
export type ServiceMap = {
  schemaVersion: 1;
  runId: string;
  state: ServiceMapState;
  coverage: {
    reasons: string[];
    examined: number;
    included: number;
    excludedType: number;
    invalid: number;
    bytesRead: number;
  };
  screens: { id: string; label: string; key: string; page: string }[];
  services: { id: string; origin: string; external: boolean }[];
  operations: { id: string; serviceId: string; method: string; path: string }[];
  observations: {
    id: string;
    operationId: string;
    screenId: string;
    resourceType: "fetch" | "xhr" | "document";
    startedMs: number;
    status: number | null;
    failed: boolean;
    durationMs: number | null;
    evidenceId?: number;
  }[];
};
