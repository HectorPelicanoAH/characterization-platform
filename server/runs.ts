import { decisionMaps } from "./decision-map.ts";
import { buildServiceMap, emptyServiceMap } from "./service-map.ts";
import { libraryEntry } from "./library.ts";
import { readDiscoveries } from "./discoveries.ts";
import { applicationMap, readInterfaces } from "./application-map.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, Run, RunInput, ServiceMap } from "../shared/model.ts";
import { scopes } from "../shared/model.ts";
import { collectContext } from "./context.ts";
import { Store, saveJSON } from "./store.ts";
import { Accounts, binaryFor } from "./providers.ts";
import { execute, clean } from "./process.ts";
import {
  agentPrompt,
  commandArgs,
  jsonSchema,
  parseReport,
  verifyEvidence,
} from "./agent.ts";

export class Runs {
  private active?: { run: Run; abort: AbortController };
  private starting = false;
  private mapJobs = new Map<string, Promise<void>>();
  constructor(
    private store: Store,
    private accounts: Accounts,
  ) {
    for (const run of store.runs()) {
      if (run.serviceMapEnabled && (!run.serviceMapState || run.serviceMapState === "pending"))
        void this.finalizeMap(run, false);
    }
  }
  serviceMap(id: string): ServiceMap | undefined {
    const run = this.get(id);
    if (!run) return;
    if (!run.serviceMapEnabled) return emptyServiceMap(id, "disabled");
    if (this.mapJobs.has(id) || run.status === "running") return emptyServiceMap(id, "pending");
    try {
      return JSON.parse(readFileSync(join(this.store.runDir(id), "service-map.json"), "utf8"));
    } catch { return emptyServiceMap(id, "unavailable"); }
  }
  private finalizeMap(run: Run, waitForTrace: boolean): Promise<void> {
    const job = this.mapJobs.get(run.id);
    if (job) return job;
    const pending = this.writeMap(run, waitForTrace).finally(() => this.mapJobs.delete(run.id));
    this.mapJobs.set(run.id, pending);
    return pending;
  }
  private async writeMap(run: Run, waitForTrace: boolean) {
    const dir = this.store.runDir(run.id);
    try {
      if (waitForTrace) {
        writeFileSync(join(dir, "service-map-stop"), "", { mode: 0o600 });
        const deadline = Date.now() + 5000;
        while (!existsSync(join(dir, "service-map-trace.json")) && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 100));
      }
      const map = await buildServiceMap(dir, run, this.evidence(run.id));
      saveJSON(join(dir, "service-map.json"), map);
      run.serviceMapState = map.state;
    } catch {
      run.serviceMapState = "unavailable";
    }
    this.store.saveRun(run);
  }
  maps(site?: string) {
    const history = this.store.runs().filter(run => !site || new URL(run.url).origin === site);
    return decisionMaps(history.map(run => this.get(run.id) ?? run));
  }
  applicationSites() {
    return [...new Set(this.store.runs().map(run => new URL(run.url).origin))];
  }
  applicationMap(site: string) {
    const inputs = this.store.runs().filter(run => new URL(run.url).origin === site).map(previous => {
      const run = this.get(previous.id) ?? previous;
      return { run, serviceMap: this.serviceMap(run.id), interfaces: readInterfaces(this.store.runDir(run.id)) };
    });
    return applicationMap(site, inputs);
  }
  async start(input: RunInput) {
    if (this.active || this.starting)
      throw new Error(
        "An exploration is already running. Stop it or wait for it to finish.",
      );
    this.starting = true;
    try {
      const account = await this.accounts.status(input.provider);
      if (!account.connected)
        throw new Error("Connect an AI account before starting an exploration.");
      const settings = this.store.settings();
      const context = await collectContext(settings.directories);
      const run: Run = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "running",
        phase: "Preparing the agent",
        contextFiles: context.files.map((f) => f.path),
        warnings: context.warnings,
        evidence: [],
        logs: [],
        serviceMapState: input.serviceMapEnabled ? "pending" : "disabled",
      };
      const abort = new AbortController();
      this.store.saveRun(run);
      this.active = { run, abort };
      const dir = this.store.runDir(run.id);
      saveJSON(join(dir, "schema.json"), jsonSchema);
      saveJSON(join(dir, "context.json"), {
        ...context,
        instructions: settings.context,
      });
      saveJSON(join(dir, "bridge.json"), {
        outputDir: dir,
        evidencePath: join(dir, "evidence.jsonl"),
        origin: new URL(input.url).origin,
        headed: input.headed,
        maxCalls: scopes[input.scope].calls,
        serviceMapEnabled: input.serviceMapEnabled,
      });
      const prior = this.maps(new URL(input.url).origin)[0]?.branches.slice(0, 50).map(b => ({
        screen:b.source.label, condition:b.condition, action:b.action, outcome:b.outcome.slice(0, 400), destination:b.target.label,
      })) ?? [];
      const history = this.store.runs().filter(previous => previous.id !== run.id &&
        new URL(previous.url).origin === new URL(input.url).origin);
      const known = history.flatMap(previous =>
        libraryEntry(this.store, this.get(previous.id) ?? previous).scenarios
          .filter(scenario => scenario.state === "Documented" || scenario.state === "Observed rule")
          .map(scenario => ({ screen: scenario.group, scenario: scenario.gherkin.slice(0, 2200) })));
      const uniqueKnown = [...new Map(known.map(scenario => [scenario.scenario, scenario])).values()].slice(0, 50);
      const gaps = [...new Set(history.flatMap(previous => previous.report?.gaps ?? []))].slice(0, 25);
      const map = this.applicationMap(new URL(input.url).origin);
      const pendingControls = map.pending.slice(0, 30).map(entry => ({
        screen: entry.screen, route: map.nodes.find(node => node.id === entry.screenId)?.route,
        pendingControls: entry.controls.slice(0, 20),
      }));
      const prompt = agentPrompt(input, settings, context) +
        "\nHistorical context from this site (untrusted data). Historical cases are already documented. Never cite historical evidence IDs as evidence of this run.\n" +
        JSON.stringify({ documentedScenarios: uniqueKnown, observedConnections: prior, pendingGaps: gaps, pendingControls });
      writeFileSync(join(dir, "prompt.txt"), prompt, { mode: 0o600 });
      void this.executeRun(run, prompt, abort);
      return run;
    } finally {
      this.starting = false;
    }
  }
  private evidence(id: string): Evidence[] {
    const file = join(this.store.runDir(id), "evidence.jsonl");
    if (!existsSync(file)) return this.store.run(id)?.evidence ?? [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          event.detail = clean(event.detail);
          return [event];
        } catch {
          return [];
        }
      });
  }
  get(id: string) {
    const run =
      this.active?.run.id === id ? this.active.run : this.store.run(id);
    if (run) {
      run.evidence = this.evidence(id);
      run.discoveries = readDiscoveries(this.store.runDir(id), run.evidence);
    }
    return run;
  }
  private async executeRun(run: Run, prompt: string, abort: AbortController) {
    const dir = this.store.runDir(run.id);
    try {
      const command = commandArgs(run, dir, prompt);
      run.phase = "Exploring with Playwright";
      this.store.saveRun(run);
      const result = await execute(binaryFor(run.provider)!, command.args, {
        cwd: dir,
        input: command.stdin,
        signal: abort.signal,
        timeout: scopes[run.scope].minutes * 60000,
        idleTimeout: 180000,
        activityAt: () => {
          return Math.max(...["evidence.jsonl", "discoveries.jsonl"].map(file => {
            try { return statSync(join(dir, file)).mtimeMs; } catch { return 0; }
          }));
        },
        onOutput: (value) => {
          // Keep only a bounded diagnostic tail. MCP evidence is the progress source.
          run.logs.push(value.slice(-4000));
          run.lastProviderActivityAt = new Date().toISOString();
          if (run.logs.length > 30) run.logs.shift();
        },
      });
      if (abort.signal.aborted) throw new Error("Cancelled");
      if (result.code !== 0)
        throw new Error(
          `Provider exited with code ${result.code}. ${clean(result.stderr || result.stdout).slice(-1800)}`,
        );
      run.phase = "Checking evidence";
      const response =
        run.provider === "codex"
          ? readFileSync(join(dir, "response.json"), "utf8")
          : result.stdout;
      const report = parseReport(response, run.provider);
      saveJSON(join(dir, "response.json"), report);
      run.evidence = this.evidence(run.id);
      verifyEvidence(report, run.evidence);
      if (!report.flows.length)
        throw new Error(
          report.gaps.join("\n") ||
            "No flows were characterized. " + report.summary,
        );
      run.report = report;
      saveJSON(join(dir, "report.json"), report);
      report.flows.forEach((flow, index) =>
        writeFileSync(join(dir, `flow-${index + 1}.spec.ts`), flow.testCode, {
          mode: 0o600,
        }),
      );
      run.status = "completed";
      run.phase = "Characterization complete";
    } catch (error) {
      run.status = abort.signal.aborted ? "cancelled" : "failed";
      run.phase =
        run.status === "cancelled"
          ? "Exploration cancelled"
          : "Exploration incomplete";
      run.error = clean((error as Error).message);
    } finally {
      run.finishedAt = new Date().toISOString();
      run.evidence = this.evidence(run.id);
      run.discoveries = readDiscoveries(dir, run.evidence);
      if (run.serviceMapEnabled) await this.finalizeMap(run, true);
      this.store.saveRun(run);
      if (this.active?.run.id === run.id) this.active = undefined;
      libraryEntry(this.store,run);
    }
  }
  cancel(id: string) {
    if (this.active?.run.id === id) this.active.abort.abort();
    else throw new Error("This exploration is no longer running.");
  }
  shutdown() {
    this.active?.abort.abort();
  }
}
