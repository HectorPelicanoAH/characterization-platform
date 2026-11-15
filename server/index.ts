import { libraryEntry } from "./library.ts";
import {diagnostics} from "./diagnostics.ts";
import express from "express";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { zipSync, strToU8 } from "fflate";
import { z } from "zod";
import { providers, settingsSchema, runInputSchema } from "../shared/model.ts";
import { Store } from "./store.ts";
import { Accounts } from "./providers.ts";
import { collectContext } from "./context.ts";
import { Runs } from "./runs.ts";
import { codexModels } from "./catalog.ts";

export async function startServer(port = Number(process.env.PORT ?? 4320)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const store = new Store(
    process.env.CHARACTERIZE_DATA_DIR ?? join(root, ".data"),
  );
  const accounts = new Accounts(store.root);
  const runs = new Runs(store, accounts);
  let catalogCache:
    { at: number; models: Awaited<ReturnType<typeof codexModels>> } | undefined;
  const app = express();
  app.disable("x-powered-by");
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host ?? ""))
      return res.status(403).json({ error: "Host no permitido." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers.origin &&
      ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
        req.headers.origin,
      )
    )
      return res.status(403).json({ error: "Origen no permitido." });
    if (req.headers["x-characterize"] !== "1")
      return res
        .status(403)
        .json({ error: "Abre la aplicación local para acceder." });
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/settings", (_req, res) => res.json(store.settings()));
  app.put("/api/settings", async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    await collectContext(settings.directories);
    store.saveSettings(settings);
    res.json(settings);
  });
  app.post("/api/context/preview", async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    const context = await collectContext(settings.directories);
    res.json({
      ...context,
      files: context.files.map(({ path, hash, content }) => ({
        path,
        hash,
        characters: content.length,
      })),
    });
  });
  app.get("/api/accounts", async (_req, res) => res.json(await accounts.all()));
  app.get("/api/models/:provider", async (req, res) => {
    const provider = z.enum(providers).parse(req.params.provider);
    if (provider === "codex") {
      if (!catalogCache || Date.now() - catalogCache.at > 300000)
        catalogCache = {
          at: Date.now(),
          models: await codexModels(store.root).catch(() => []),
        };
      return res.json(catalogCache.models);
    }
    res.json(
      provider === "claude"
        ? ["sonnet", "opus", "haiku"].map((id) => ({
            id,
            name: id,
            efforts: [],
          }))
        : [],
    );
  });
  app.post("/api/accounts/:id/login", (req, res) => {
    accounts.startLogin(z.enum(providers).parse(req.params.id));
    res.json({ started: true });
  });
  app.post("/api/accounts/:id/cancel", (req, res) => {
    accounts.cancelLogin(z.enum(providers).parse(req.params.id));
    res.json({ cancelled: true });
  });
  diagnostics(app,store,runs);
  function library() {
    return store.runs().map(run => libraryEntry(store, runs.get(run.id) ?? run)).filter(entry => entry.scenarios.length);
  }
  library(); // Recover earlier runs on startup without inference.
  app.delete("/api/recent/:id",(req,res)=>{
    const run=store.run(req.params.id);
    if(!run)return res.status(404).json({error:"Exploración no encontrada"});
    if(run.status==="running")return res.status(409).json({error:"Espera a que termine la exploración."});
    store.exclude(run.id);
    res.json({removed:true});
  });
  app.delete("/api/library/:id/:scenario",(req,res)=>{
    const run=runs.get(req.params.id);
    if(!run)return res.status(404).json({error:"Exploración no encontrada"});
    if(run.status==="running")return res.status(409).json({error:"Espera a que termine la exploración."});
    if(!libraryEntry(store,run).scenarios.some(s=>s.id===req.params.scenario))return res.status(404).json({error:"Escenario no encontrado"});
    store.exclude(run.id,req.params.scenario);
    res.json(libraryEntry(store,run));
  });
  app.get("/api/library", (_req,res)=>res.json(library()));
  app.get("/api/runs/:id/scenarios", (req,res)=>{
    const run=runs.get(req.params.id);
    if(!run) return res.status(404).json({error:"Exploración no encontrada"});
    res.json(libraryEntry(store,run));
  });
  app.get("/api/runs", (_req, res) =>
    res.json(
      store
        .runs()
        .map(({ logs, evidence, report, ...run }) => ({
          ...run,
          flowCount: report?.flows.length ?? 0,
          removedFromRecent:store.exclusions(run.id).recent,
        })),
    ),
  );
  app.post("/api/runs", async (req, res) => {
    const input = runInputSchema.parse(req.body);
    if (hosts.has(new URL(input.url).host))
      throw new Error(
        "Elige la web que quieres caracterizar, no esta plataforma.",
      );
    res.status(201).json(await runs.start(input));
  });
  app.get("/api/runs/:id", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run)
      return res.status(404).json({ error: "Exploración no encontrada." });
    res.json(run);
  });
  app.post("/api/runs/:id/cancel", (req, res) => {
    runs.cancel(req.params.id);
    res.json({ cancelled: true });
  });
  app.get("/api/runs/:id/export", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run?.report)
      return res
        .status(404)
        .json({ error: "Todavía no hay resultados para exportar." });
    const files: Record<string, Uint8Array> = {
      "report.json": strToU8(JSON.stringify(run.report, null, 2)),
      "evidence.json": strToU8(JSON.stringify(run.evidence, null, 2)),
      "package.json": strToU8(
        JSON.stringify(
          {
            name: "characterization-suite",
            private: true,
            type: "module",
            scripts: { test: "playwright test" },
            devDependencies: { "@playwright/test": "1.65.1" },
          },
          null,
          2,
        ),
      ),
      "playwright.config.ts": strToU8(
        "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { trace: 'retain-on-failure' }, reporter: [['list'], ['html', { open: 'never' }]] });\n",
      ),
      "README.md": strToU8(
        `# Caracterización de ${run.url}\n\n${run.report.summary}\n\nTests GENERADOS, pendientes de revisión y ejecución. La evidencia describe observaciones del agente, no certifica que el código pase. Revisa los tests antes de ejecutarlos.\n\nInstalación: npm install\nNavegador: npx playwright install chromium\nEjecución: npm test\n\nLimitaciones:\n${run.report.gaps.map((g) => "- " + g).join("\n")}\n`,
      ),
    };
    run.report.flows.forEach((flow, i) => {
      files[`tests/flow-${i + 1}.spec.ts`] = strToU8(flow.testCode);
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="characterization-${run.id.slice(0, 8)}.zip"`,
    );
    res.send(Buffer.from(zipSync(files)));
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Ruta no encontrada." }),
  );
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(400)
        .json({
          error:
            error instanceof z.ZodError
              ? error.issues.map((i) => i.message).join("\n")
              : error.message,
        });
    },
  );
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  if (process.argv.includes("--production")) {
    app.use(express.static(join(root, "dist")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(join(root, "dist", "index.html")),
    );
  } else {
    vite = await createServer({
      root,
      server: { middlewareMode: true, hmr: false, fs:{deny:["**/.data/**","**/.env*","**/.git/**","**/*.{pem,crt}"]} },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }
  const server = app.listen(port, "127.0.0.1", () =>
    console.log(`Characterize · http://127.0.0.1:${port}`),
  );
  const close = async () => {
    runs.shutdown();
    accounts.shutdown();
    await vite?.close();
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { server, close };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await startServer();
