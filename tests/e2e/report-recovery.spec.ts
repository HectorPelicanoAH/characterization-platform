import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../../shared/model";

test("an interrupted recording resumes its saved report without starting another journey", async ({ page }) => {
  const id = randomUUID();
  const input = runInputSchema.parse({ url: "https://saved-recording.test", provider: "copilot", scope: "exhaustive" });
  let resumes = 0, newJourneys = 0;
  const run: Run = { ...input, id, createdAt: new Date().toISOString(), status: "failed", phase: "Exploration incomplete", error: "Report generation interrupted", logs: [], warnings: [], contextFiles: [],
    evidence: [{ id: 1, tool: "browser_navigate", ok: true, at: new Date().toISOString(), detail: "- Page URL: https://saved-recording.test/" }],
    discoveries: [{ id: "saved-rule", at: new Date().toISOString(), capabilityKey: "catalog-view", capability: "View catalog", component: "Catalog", given: "the catalog is open", action: "view the products", observed: "available products are displayed", scope: "observed", examples: [], evidenceIds: [1], screenEvidenceId: 1 }],
  };
  await page.route("**/api/accounts", route => route.fulfill({ json: [{ id: "copilot", installed: true, connected: true }] }));
  await page.route("**/api/models/copilot", route => route.fulfill({ json: [] }));
  await page.route("**/api/characterization", route => route.fulfill({ json: input }));
  await page.route("**/api/runs", route => {
    if (route.request().method() === "POST") newJourneys++;
    return route.fulfill({ json: [{ ...run, flowCount: 0 }] });
  });
  await page.route("**/api/runs/" + id, route => route.fulfill({ json: run }));
  await page.route("**/api/runs/" + id + "/scenarios", route => route.fulfill({ json: { id, url: input.url, status: run.status, createdAt: run.createdAt, scenarios: [], feature: "" } }));
  await page.route("**/api/runs/" + id + "/resume", route => {
    resumes++; run.status = "running"; delete run.error;
    run.phase = "Completing saved tests · 0/1 rules";
    run.reportRecovery = { startedAt: new Date().toISOString(), completedRules: 0, totalRules: 1 };
    return route.fulfill({ status: 202, json: run });
  });
  await page.goto("/");
  await page.locator(".history-link").filter({ hasText: "saved-recording.test" }).click();
  await page.getByRole("button", { name: "Complete saved report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Completing saved tests · 0/1 rules" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("0/1 rules processed");
  await expect(page.getByText("Generating the final tests and report from the saved browser observations.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(resumes).toBe(1); expect(newJourneys).toBe(0); expect(run.evidence).toHaveLength(1);
});
