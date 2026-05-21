import { test, expect } from "@playwright/test";

test("dashboard can bootstrap a task pair and attach terminals", async ({ page }) => {
  await page.goto(process.env.DASHBOARD_URL || "http://127.0.0.1:8797/");

  const bootstrap = page.locator(".bootstrap-grid");
  await bootstrap.getByLabel("Task").fill("dashboard-bootstrap-dogfood");
  await bootstrap.getByLabel("Goal").fill("Verify browser-created dashboard pair.");
  await bootstrap.getByLabel("Worker prompt").fill("Report dashboard bootstrap readiness.");
  await bootstrap.getByLabel("Worker", { exact: true }).fill("dashboard-bootstrap-worker");
  await bootstrap.getByLabel("Manager", { exact: true }).fill("dashboard-bootstrap-manager");
  await bootstrap.getByRole("button", { name: "Start Pair" }).click();

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
