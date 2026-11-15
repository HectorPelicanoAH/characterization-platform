import { z } from "zod";

export const providers = ["codex", "claude", "copilot"] as const;
export type Provider = (typeof providers)[number];
export const scopes = {
  smoke: {
    label: "Smoke",
    description: "Acceso y flujos principales",
    calls: 30,
    minutes: 8,
    flows: "3–5",
  },
  standard: {
    label: "Funcional",
    description: "Navegación y caminos habituales",
    calls: 80,
    minutes: 20,
    flows: "6–12",
  },
  deep: {
    label: "En detalle",
    description: "Variantes, estados y validaciones",
    calls: 160,
    minutes: 40,
    flows: "12–25",
  },
  exhaustive: {
    label: "Exhaustiva",
    description: "Límites y recorridos alternativos",
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
    }, "Usa una URL HTTP(S) sin credenciales."),
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
});
export type RunInput = z.infer<typeof runInputSchema>;
export const reportSchema = z.object({
  summary: z.string().min(1).max(12000),
  flows: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        steps: z.array(z.string().max(2000)).min(1).max(60),
        observed: z.string().min(1).max(8000),
        evidenceIds: z.array(z.number().int().positive()).min(1).max(100),
        testCode: z.string().min(1).max(40000),
      }),
    )
    .max(80),
  gaps: z.array(z.string().max(3000)).max(100),
});
export type Report = z.infer<typeof reportSchema>;
export type Account = {
  id: Provider;
  installed: boolean;
  connected: boolean;
  version?: string;
  message?: string;
  login?: { status: string; output: string };
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
  externalUrl?: string;
  externalUrls?: string[];
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
};
