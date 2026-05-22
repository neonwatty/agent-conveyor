import { test, expect } from "@playwright/test";

test("dashboard shows progress while pair startup is running", async ({ page }) => {
  await page.route("**/api/actions/start-pair", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        command: ["scripts/workerctl", "pair", "--task", "delayed-ui-test"],
        exitCode: 1,
        json: null,
        stderr: "delayed test failure",
        stdout: "",
      }),
    });
  });

  await page.goto(process.env.DASHBOARD_URL || "http://127.0.0.1:8797/");
  await page.getByRole("button", { name: "Start & Attach Pair" }).first().click();

  await expect(page.getByText("Starting worker and manager...")).toBeVisible();
  await expect(page.getByRole("button", { name: "Starting Pair..." }).first()).toBeVisible();
  await expect(page.locator(".status-callout").filter({ hasText: "Action failed" }).getByText("delayed test failure")).toBeVisible({ timeout: 5000 });
});

test("dashboard can bootstrap a task pair and attach terminals", async ({ page }) => {
  await page.goto(process.env.DASHBOARD_URL || "http://127.0.0.1:8797/");

  const bootstrap = page.locator(".bootstrap-grid");
  await bootstrap.getByLabel("Task").fill("dashboard-bootstrap-dogfood");
  await bootstrap.getByLabel("Goal").fill("Verify browser-created dashboard pair.");
  await bootstrap.getByLabel("Worker prompt").fill("Report dashboard bootstrap readiness.");
  await bootstrap.getByLabel("Worker", { exact: true }).fill("dashboard-bootstrap-worker");
  await bootstrap.getByLabel("Manager", { exact: true }).fill("dashboard-bootstrap-manager");
  await bootstrap.getByRole("button", { name: "Start & Attach Pair" }).click();

  await expect(page.getByText("dashboard-bootstrap-dogfood")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText("codex-dashboard-bootstrap-worker")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText("codex-dashboard-bootstrap-manager")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText(/worker dashboard-bootstrap-worker terminal ready/)).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText(/manager dashboard-bootstrap-manager terminal ready/)).toBeVisible();

  await page.getByRole("button", { name: "Cycle" }).click();
  await expect(page.getByText(/cycle dashboard-bootstrap-dogfood/)).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByText(/export-task dashboard-bootstrap-dogfood --zip/)).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: "/tmp/workerctl-dashboard-bootstrap.png", fullPage: true });
});
