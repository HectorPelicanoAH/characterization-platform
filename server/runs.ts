import { libraryEntry } from "./library.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, Run, RunInput } from "../shared/model.ts";
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
  constructor(
    private store: Store,
    private accounts: Accounts,
  ) {}
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
      });
      const prompt = agentPrompt(input, settings, context);
      writeFileSync(join(dir, "prompt.txt"), prompt, { mode: 0o600 });
      void this.executeRun(run, prompt, abort);
      return run;
    } finally {
      this.starting = false;
    }
  }
  private evidence(id: string): Evidence[] {
    const file = join(this.store.runDir(id), "evidence.jsonl");
    if (!existsSync(file)) return [];
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
    if (run) run.evidence = this.evidence(id);
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
        onOutput: (value) => {
          // Keep only a bounded diagnostic tail. MCP evidence is the progress source.
          run.logs.push(value.slice(-4000));
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
