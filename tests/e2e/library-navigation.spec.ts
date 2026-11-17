import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Run } from "../../shared/model";
import { libraryEntry } from "../../server/library";
import { Store } from "../../server/store";

test("library folders scope scenarios, open details and search across applications", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "library-browser-"));
  const store = new Store(root);
  const sites = ["https://library-browser.test", "https://library-accounts.test"];
  try {
    const entries = sites.map((site, index) => {
      const flow = { title: "Apply catalog filter", given: "the catalog is open", steps: ["the user applies an available filter"], observed: "the selected filter is active", evidenceIds: [1],
        testCode: "import {test,expect} from '@playwright/test';test('page',async({page})=>{await expect(page.getByRole('heading')).toBeVisible()});" };
      const run: Run = { ...runInputSchema.parse({ url: site, provider: "codex" }), id: randomUUID(), status: "completed", phase: "Complete", createdAt: new Date().toISOString(), logs: [], warnings: [], contextFiles: [],
        evidence: [
          { id: 1, tool: "browser_snapshot", at: "", ok: true, detail: "- Page URL: " + site + "/catalog\n- Page Title: Catalog" },
          { id: 2, tool: "browser_snapshot", at: "", ok: true, detail: "- Page URL: " + site + "/cart\n- Page Title: Cart" },
        ], report: { summary: "Library fixture", decisions: [], gaps: [], flows: index === 0 ? [flow,
          { ...flow, title: "Empty catalog results", observed: "an empty state is displayed" },
          { ...flow, title: "Remove the last bag line", given: "the bag contains one line", steps: ["the user removes the line"], observed: "the bag is empty", evidenceIds: [2] },
        ] : [{ ...flow, title: "Recover an account", observed: "recovery instructions are displayed" }] } };
      store.saveRun(run); return libraryEntry(store, run);
    });
    await page.route("**/api/library", route => route.fulfill({ json: entries }));
    await page.route("**/api/accounts", route => route.fulfill({ json: [] }));
    await page.goto("/");
    await page.getByRole("button", { name: "Local library", exact: true }).click();
    const folders = page.getByRole("navigation", { name: "Scenario folders" });
    const details = page.getByLabel("Scenario details");
    await expect(details.locator(".flow-card")).toHaveCount(4);
    const app = folders.locator('summary[title="' + sites[0] + '"]');
    await app.click();
    await expect(details.locator(".flow-card")).toHaveCount(3);
    await app.locator("..").locator(".library-screen-folder > summary").filter({ hasText: "Catalog" }).click();
    await expect(details.locator(".flow-card")).toHaveCount(2);
    await folders.getByRole("button", { name: "Apply catalog filter", exact: true }).click();
    await expect(details.locator(".flow-card")).toHaveCount(1);
    await expect(details.locator("pre")).toContainText("the selected filter is active");
    const href = await details.getByRole("link", { name: "Download .feature" }).getAttribute("href");
    const exported = decodeURIComponent(href!.split(",").slice(1).join(","));
    expect(exported).toContain("Scenario: Apply catalog filter");
    expect(exported).not.toContain("Empty catalog results");
    const folderBox = await folders.boundingBox(), detailBox = await details.boundingBox();
    expect(folderBox!.x + folderBox!.width).toBeLessThanOrEqual(detailBox!.x + 1);
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    await page.screenshot({ path: "test-results/library-folders-desktop-light.png", fullPage: true });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await page.screenshot({ path: "test-results/library-folders-desktop-dark.png", fullPage: true });
    await page.getByRole("searchbox", { name: "Search scenarios" }).fill("Recover an account");
    await expect(details.locator(".flow-card")).toHaveCount(1);
    await expect(details.locator("summary")).toContainText("Recover an account");
    await page.getByRole("searchbox", { name: "Search scenarios" }).fill("no matching behavior");
    await expect(details.getByRole("heading", { name: "No scenarios found" })).toBeVisible();
    await page.getByRole("button", { name: "Clear scenario search" }).click();
    await expect(details.locator(".flow-card")).toHaveCount(4);
    await app.focus(); await app.press("Enter");
    await expect(details.locator(".flow-card")).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/library-folders-mobile-dark.png", fullPage: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
