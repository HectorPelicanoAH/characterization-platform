import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditExploration, ExplorationActivity, reportTimeoutMs } from "../server/exploration.ts";
import { execute } from "../server/process.ts";
import { commandArgs } from "../server/agent.ts";
import { runInputSchema } from "../shared/model.ts";

test("a closed or exhausted browser journey gets a separate bounded report phase", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-report-phase-"));
  try {
    const activity = new ExplorationActivity(dir, 10000000);
    assert.equal(activity.update(1000), false);
    assert.equal(activity.idleTimeout(), 180000);
    await writeFile(join(dir, "exploration-progress.json"), JSON.stringify({ usedCalls: 280, maxCalls: 280, completion: { reason: "budget_exhausted" } }));
    assert.equal(activity.update(2000), true);
    assert.equal(activity.idleTimeout(), reportTimeoutMs);
    assert.equal(activity.deadline(), 2000 + reportTimeoutMs);
    assert.equal(activity.update(2000 + 180001), true, "The old three-minute browser timeout must not stop report synthesis");
    assert.equal(activity.deadline(), 2000 + reportTimeoutMs, "Activity must not extend the absolute report deadline");
    const early = new ExplorationActivity(dir, 10000000);
    await writeFile(join(dir, "exploration-progress.json"), JSON.stringify({ usedCalls: 25, maxCalls: 280, completion: { reason: "alternatives_exhausted" } }));
    assert.equal(early.update(1000), true);
    const elapsed = new ExplorationActivity(join(dir, "missing"), 1000);
    assert.equal(elapsed.update(1001), true, "Reaching the browser time budget reserves time for the report");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a quiet synthesis worker survives the browser idle threshold, while its absolute deadline still applies", async () => {
  const started = Date.now();
  const result = await execute(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('final report'),350)"], {
    timeout: 3000, idleTimeout: 120,
    idleTimeoutFor: () => Date.now() - started > 40 ? 1000 : 120,
  });
  assert.equal(result.stdout, "final report");
  await assert.rejects(execute(process.execPath, ["-e", "setInterval(()=>process.stdout.write('still writing'),20)"], {
    timeout: 3000, idleTimeout: 1000, deadlineAt: () => Date.now() > started + 600 ? started + 600 : undefined,
  }), /timed out/);
});

test("Copilot streams output so report generation exposes real provider activity", () => {
  const command = commandArgs(runInputSchema.parse({ url: "https://fixture.test", provider: "copilot" }), "/private/tmp/report-fixture", "prompt");
  assert.equal(command.args[command.args.indexOf("--stream") + 1], "on");
});

test("report audit retains recorded closure limitations with human screen names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "characterize-closure-limits-"));
  try {
    await writeFile(join(dir, "exploration-progress.json"), JSON.stringify({ usedCalls: 280, maxCalls: 280, screens: [],
      completion: { reason: "budget_exhausted", detail: "Saved the observations", remaining: [{ route: "Payment", reason: "Purchasing requires specific authorization." }] } }));
    const report = { summary: "Recorded behavior", flows: [], decisions: [], gaps: [] as string[] };
    auditExploration(dir, report);
    assert.ok(report.gaps.some(gap => gap.includes("Purchasing requires specific authorization")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
