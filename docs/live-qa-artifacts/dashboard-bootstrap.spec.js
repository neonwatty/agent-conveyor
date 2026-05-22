import { test, expect } from "@playwright/test";

test("dashboard shows progress while binding sessions", async ({ page }) => {
  await page.route("**/api/actions/bind", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        command: ["scripts/workerctl", "bind", "--task", "delayed-ui-test"],
        exitCode: 1,
        json: null,
        stderr: "delayed test failure",
        stdout: "",
      }),
    });
  });

  await page.goto(process.env.DASHBOARD_URL || "http://127.0.0.1:8797/");
  const bootstrap = page.locator(".bootstrap-grid");
  await bootstrap.getByLabel("Task").fill("delayed-ui-test");
  await bootstrap.getByLabel("Goal").fill("Delayed bind test.");
  await page.getByRole("button", { name: "Create Task Only" }).click();
  await bootstrap.getByLabel("Worker").selectOption("dashboard-bootstrap-worker");
  await bootstrap.getByLabel("Manager").selectOption("dashboard-bootstrap-manager");
  await page.getByRole("button", { name: "Bind Selected Sessions" }).click();

  await expect(page.getByText("Running command...")).toBeVisible();
  await expect(page.locator(".status-callout").filter({ hasText: "Action failed" }).getByText("delayed test failure")).toBeVisible({ timeout: 5000 });
});

test("dashboard can bind manual sessions, attach terminals, and show activity", async ({ page }) => {
  await page.goto(process.env.DASHBOARD_URL || "http://127.0.0.1:8797/");

  const bootstrap = page.locator(".bootstrap-grid");
  await bootstrap.getByLabel("Task").fill("dashboard-bootstrap-dogfood");
  await bootstrap.getByLabel("Goal").fill("Verify browser-created dashboard pair.");
  await page.getByRole("button", { name: "Create Task Only" }).click();
  await bootstrap.getByLabel("Worker").selectOption("dashboard-bootstrap-worker");
  await bootstrap.getByLabel("Manager").selectOption("dashboard-bootstrap-manager");
  await page.getByRole("button", { name: "Bind Selected Sessions" }).click();

  await expect(page.getByRole("heading", { name: "dashboard-bootstrap-dogfood" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText("codex-dashboard-bootstrap-worker")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText("codex-dashboard-bootstrap-manager")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText(/worker dashboard-bootstrap-worker terminal ready/)).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText(/manager dashboard-bootstrap-manager terminal ready/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity replay" })).toBeVisible();
  await expect(page.getByText(/Command ok: bind --task dashboard-bootstrap-dogfood/)).toBeVisible();

  await page.getByRole("button", { name: "Cycle" }).click();
  await expect(page.getByText(/cycle dashboard-bootstrap-dogfood/)).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByText(/export-task dashboard-bootstrap-dogfood --zip/)).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: "/tmp/workerctl-dashboard-bootstrap.png", fullPage: true });
});
