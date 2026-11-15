import { test, expect } from "@playwright/test";

test("setup, context persistence, coverage and provider requirements work on desktop and mobile", async ({
  page,
}) => {
  // No account or inference is needed for the UI acceptance test.
  await page.route("**/api/accounts", (route) =>
    route.fulfill({
      json: ["codex", "claude", "copilot"].map((id) => ({
        id,
        installed: true,
        connected: false,
      })),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Give your agent context." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start exploring" }),
  ).toBeDisabled();
  await page
    .getByLabel("Agent instructions")
    .fill("Prioriza navegación y catálogo.");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Settings saved",
  );
  const theme = page.getByRole("button", { name: "Dark mode" });
  const previous = await theme.getAttribute("aria-pressed");
  await theme.click();
  await page.reload();
  await expect(theme).toHaveAttribute("aria-pressed", previous === "true" ? "false" : "true");
  await expect(page.getByLabel("Agent instructions")).toHaveValue(
    "Prioriza navegación y catálogo.",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/settings-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Characterization", exact: false })
    .first()
    .click();
  await page.getByLabel("Starting URL").fill("https://example.com");
  await page.getByRole("radio", { name: /Detailed/ }).check();
  await expect(page.getByRole("radio", { name: /Detailed/ })).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start characterization" }),
  ).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/explore-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Start characterization" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/explore-mobile.png",
    fullPage: true,
  });
});

test("local API rejects cross-origin, missing headers and malformed input", async ({
  request,
}) => {
  expect((await request.get("/api/settings")).status()).toBe(403);
  expect(
    (
      await request.get("/api/settings", {
        headers: { "X-Characterize": "1", Origin: "https://evil.example" },
      })
    ).status(),
  ).toBe(403);
  const headers = { "X-Characterize": "1" };
  expect(
    (
      await request.post("/api/runs", {
        headers,
        data: { url: "file:///tmp/test", provider: "codex" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/context/preview", {
        headers,
        data: { directories: ["/does-not-exist"] },
      })
    ).status(),
  ).toBe(400);
  expect((await request.get("/api/settings", { headers })).status()).toBe(200);
});
