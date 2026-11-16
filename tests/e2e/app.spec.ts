import { test, expect } from "@playwright/test";

test("Copilot opens sign-in, asks for an account and disconnects", async ({ page, context }) => {
  let connected = false;
  await page.route("**/api/models/copilot", route => route.fulfill({ json: [{ id: "fixture-copilot-model", name: "Account model", efforts: [] }] }));
  let login: { status: string; output: string; url?: string; prompt?: { message: string; choices: { value: string; label: string }[] } } | undefined;
  await context.route("https://github.com/login/oauth/authorize*", route => route.fulfill({ contentType: "text/html", body: "<h1>GitHub sign-in fixture</h1>" }));
  await page.route("**/api/accounts", route => route.fulfill({ json: ["codex", "claude", "copilot"].map(id => ({ id, installed: true, connected: id === "copilot" && connected, login: id === "copilot" ? login : undefined })) }));
  await page.route("**/api/accounts/copilot/login", route => {
    login = { status: "running", output: "Waiting", url: "https://github.com/login/oauth/authorize?fixture=1" };
    return route.fulfill({ json: { started: true } });
  });
  await page.route("**/api/accounts/copilot/answer", route => {
    expect(route.request().postDataJSON().value).toBe("second-account");
    connected = true;
    login = { status: "completed", output: "Account connected." };
    return route.fulfill({ json: { accepted: true } });
  });
  await page.route("**/api/accounts/copilot/disconnect", route => {
    connected = false;
    login = undefined;
    return route.fulfill({ json: { disconnected: true } });
  });
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Copilot" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "GitHub sign-in fixture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open sign-in" })).toBeVisible();
  login = { status: "running", output: "Choose account", prompt: { message: "Choose your GitHub account.", choices: [{ value: "first-account", label: "personal-account" }, { value: "second-account", label: "work-account" }] } };
  await page.getByRole("button", { name: "work-account" }).click();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await page.getByRole("button", { name: "Characterization", exact: false }).first().click();
  await expect(page.getByRole("combobox").filter({ has: page.locator("option[value='copilot']") })).toHaveValue("copilot");
  await expect(page.locator("#models option[value='fixture-copilot-model']")).toHaveCount(1);
  await page.getByRole("button", { name: /Settings/ }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/login-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect Copilot" })).toBeVisible();
  await popup.close();
});

test("blocked Copilot popups recover after reload and consent can be cancelled", async ({ page }) => {
  let login: { status: string; output: string; url?: string; prompt?: { message: string; choices: { value: string; label: string }[] } } | undefined;
  await page.addInitScript(() => { window.open = () => null; });
  await page.route("**/api/accounts", route => route.fulfill({ json: ["codex", "claude", "copilot"].map(id => ({ id, installed: true, connected: false, login: id === "copilot" ? login : undefined })) }));
  await page.route("**/api/accounts/copilot/login", route => {
    login = { status: "running", output: "Waiting for GitHub", url: "https://github.com/login/oauth/authorize?fixture=blocked" };
    return route.fulfill({ json: { started: true } });
  });
  await page.route("**/api/accounts/copilot/cancel", route => {
    login = { status: "cancelled", output: "Sign-in cancelled." };
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Copilot" }).click();
  await expect(page.getByRole("link", { name: "Open sign-in" })).toHaveAttribute("href", "https://github.com/login/oauth/authorize?fixture=blocked");
  login = { status: "running", output: "Waiting for consent", prompt: { message: "Allow storage without encryption on this computer?", choices: [{ value: "allow", label: "Save connection" }, { value: "deny", label: "Do not save" }] } };
  await page.reload();
  await expect(page.getByRole("group", { name: "Confirm connection" })).toContainText("without encryption");
  await expect(page.getByRole("button", { name: "Save connection", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Do not save", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open sign-in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start exploring" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(page.getByRole("group", { name: "Confirm connection" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect Copilot" })).toBeEnabled();
});

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
  await expect(page.getByLabel("Generate service map")).not.toBeChecked();
  await expect(page.getByLabel("Prioritize unexplored paths")).toBeChecked();
  await page.getByLabel("Generate service map").check();
  await expect(page.getByLabel("Generate service map")).toBeChecked();
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
