import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../shared/model.ts";

export const reportTimeoutMs = 10 * 60000;
export class ExplorationActivity {
  private modified = -1;
  private closed = false;
  private reportStarted?: number;
  constructor(private dir: string, private explorationDeadline: number, private reportLimit = reportTimeoutMs) {}
  update(now = Date.now()) {
    try {
      const file = join(this.dir, "exploration-progress.json"), modified = statSync(file).mtimeMs;
      if (modified !== this.modified) {
        const progress = JSON.parse(readFileSync(file, "utf8"));
        this.closed = !!progress.completion || progress.usedCalls >= progress.maxCalls;
        this.modified = modified;
      }
    } catch { /* Browser startup may not have produced a progress file yet. */ }
    if (this.closed || now >= this.explorationDeadline) this.reportStarted ??= now;
    else this.reportStarted = undefined;
    return this.reportStarted !== undefined;
  }
  idleTimeout() { return this.reportStarted !== undefined ? this.reportLimit : 180000; }
  deadline() { return this.reportStarted === undefined ? undefined : this.reportStarted + this.reportLimit; }
}

export function auditExploration(dir: string, report: Report) {
  const file = join(dir, "exploration-progress.json");
  if (!existsSync(file)) return;
  const progress = JSON.parse(readFileSync(file, "utf8")) as {
    usedCalls: number; maxCalls: number;
    screens: { screen: string; route: string; pendingCount: number; blocked: number }[];
    completion?: { reason: string; detail: string; remaining: { route: string; reason: string }[] };
  };
  const gaps: string[] = [];
  if (!progress.completion) gaps.push(`The agent ended after ${progress.usedCalls}/${progress.maxCalls} browser calls without confirming its review of remaining alternatives.`);
  else if (progress.completion.reason !== "alternatives_exhausted") gaps.push(`Exploration stopped after ${progress.usedCalls}/${progress.maxCalls} browser calls: ${progress.completion.detail}`);
  for (const remaining of progress.completion?.remaining ?? []) gaps.push(`${remaining.route}: ${remaining.reason}`);
  for (const screen of progress.screens) {
    if (!screen.pendingCount && !screen.blocked) continue;
    const reason = progress.completion?.remaining.find(item => item.route === screen.route)?.reason;
    gaps.push(`${screen.screen}: ${screen.pendingCount} controls not exercised; ${screen.blocked} disabled or failed controls. ${reason ?? "Their remaining behavior has not been verified."}`);
  }
  report.gaps = [...new Set([...report.gaps, ...gaps])].slice(-100);
}
