import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Run, Settings } from "../shared/model.ts";
import { characterizationSchema, settingsSchema } from "../shared/model.ts";
import type { ScenarioText } from "../shared/scenario.ts";

export type ScenarioRefinement = { text: ScenarioText; comment: string; at: string };

export function saveJSON(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
export class Store {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(join(this.root, "runs"), { recursive: true, mode: 0o700 });
    for (const run of this.runs())
      if (run.status === "running") {
        run.status = "interrupted";
        run.phase = "Interrupted by restart";
        run.finishedAt = new Date().toISOString();
        this.saveRun(run);
      }
  }
  settings(): Settings {
    const path = join(this.root, "settings.json");
    return existsSync(path)
      ? settingsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { context: "", directories: [] };
  }
  saveSettings(settings: Settings) {
    saveJSON(join(this.root, "settings.json"), settings);
  }
  characterization() {
    const path = join(this.root, "characterization.json");
    return characterizationSchema.parse(existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : this.runs()[0] ?? { provider: "codex" });
  }
  saveCharacterization(input: unknown) {
    const value = characterizationSchema.parse(input);
    saveJSON(join(this.root, "characterization.json"), value);
    return value;
  }
  runDir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid identifier");
    return join(this.root, "runs", id);
  }
  exclusions(id: string): { recent: boolean; scenarios: string[] } {
    const path = join(this.runDir(id), "exclusions.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {recent:false, scenarios:[]};
  }
  exclude(id:string, scenario?:string) {
    const state=this.exclusions(id);
    if (scenario) state.scenarios=[...new Set([...state.scenarios,scenario])];
    else state.recent=true;
    saveJSON(join(this.runDir(id),"exclusions.json"),state);
  }
  refinements(): Record<string, ScenarioRefinement> {
    const file = join(this.root, "library-refinements.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  saveRefinements(value: Record<string, ScenarioRefinement>) {
    saveJSON(join(this.root, "library-refinements.json"), value);
  }
  saveRun(run: Run) {
    mkdirSync(this.runDir(run.id), { recursive: true, mode: 0o700 });
    saveJSON(join(this.runDir(run.id), "run.json"), run);
  }
  run(id: string): Run | undefined {
    const path = join(this.runDir(id), "run.json");
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  }
  runs(): Run[] {
    return readdirSync(join(this.root, "runs"))
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .flatMap((id) => {
        try {
          return this.run(id) ?? [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
