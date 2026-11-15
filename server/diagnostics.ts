import express from "express";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import type { Store } from "./store.ts";
import type { Runs } from "./runs.ts";
import { libraryEntry } from "./library.ts";

// Only serve native artifacts by an unguessable, run-scoped URL. The viewer's
// service worker cannot attach the API header when fetching its trace data.
export function diagnostics(app: express.Express, store: Store, runs: Runs) {
  const secret = randomBytes(32);
  const ticket = (id: string) =>
    createHmac("sha256", secret).update(id).digest("hex");
  const assetDir = join(
    dirname(
      createRequire(import.meta.url).resolve("playwright-core/package.json"),
    ),
    "lib/vite/traceViewer",
  );
  app.use(
    "/trace-viewer",
    (_req, res, next) => {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      next();
    },
    express.static(assetDir, { fallthrough: false }),
  );
  function files(id: string) {
    const root = join(store.runDir(id), "traces");
    if (!existsSync(root) || realpathSync(root) !== root) return [];
    const regular = (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    const list = regular(root).filter((n) =>
      /^trace-[\w-]+\.(trace|network|stacks)$/.test(n),
    );
    for (const sub of ["resources", "screencast", "screenshots", "aria"]) {
      const resources = join(root, sub);
      if (existsSync(resources) && realpathSync(resources) === resources)
        list.push(...regular(resources).map((n) => sub + "/" + n));
    }
    return list;
  }
  app.get("/api/runs/:id/diagnosis", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run)
      return res.status(404).json({ error: "Exploración no encontrada" });
    const scenarios = libraryEntry(store, run,true).scenarios;
    const failed = run.evidence.filter((e) => !e.ok);
    const issues = scenarios
      .filter((s) => s.state === "Revisar evidencia")
      .map((s) => ({
        title: s.title,
        ids: s.ids.filter(
          (id) => !run.evidence.some((e) => e.id === id && e.ok),
        ),
      }));
    const available = files(run.id).some((n) => n.endsWith(".trace"));
    const prefix = "/trace-data/" + run.id + "/" + ticket(run.id);
    res.json({
      url: run.url,
      status: run.status,
      error: run.error,
      issues,
      failed,
      viewer: available
        ? "/trace-viewer/index.html?trace=" +
          encodeURIComponent(
            "http://" + req.headers.host + prefix + "/traces.dir",
          )
        : null,
    });
  });
  app.get("/trace-data/:id/:key/*path", (req, res) => {
    const { id, key } = req.params;
    const expected = ticket(id);
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      return res.sendStatus(404);
    const name = (req.params.path as unknown as string[]).join("/");
    const list = files(id);
    res.set("Cache-Control", "no-store");
    if (name === "traces.dir")
      return res.json({
        entries: list.map((n) => ({
          name: n,
          path:
            "/trace-data/" +
            id +
            "/" +
            key +
            "/" +
            n.split("/").map(encodeURIComponent).join("/"),
        })),
      });
    if (!list.includes(name)) return res.sendStatus(404);
    res
      .type("application/octet-stream")
      .sendFile(resolve(store.runDir(id), "traces", name), {
        dotfiles: "allow",
      });
  });
}
