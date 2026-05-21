import { test, expect } from "@playwright/test";

test("dashboard dogfood actions", async ({ page }) => {
  await page.goto("http://127.0.0.1:8797/?task=dashboard-dogfood-final2-20260521");
  await expect(page.getByText("dashboard-dogfood-final2-20260521")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText("dashboard-dogfood-final2-worker")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText("dashboard-dogfood-final2-manager")).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Worker" }).getByText(/worker final2 dashboard dogfood terminal ready/)).toBeVisible();
  await expect(page.locator(".terminal-panel").filter({ hasText: "Manager" }).getByText(/manager final2 dashboard dogfood terminal ready/)).toBeVisible();

  await page.getByRole("button", { name: "Cycle" }).click();
  await expect(page.getByText(/cycle dashboard-dogfood-final2-20260521/)).toBeVisible({ timeout: 10000 });

  await page.getByPlaceholder("Message to send to worker").fill("Dashboard dogfood nudge from Playwright.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/session-nudge dashboard-dogfood-final2-worker/)).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByText(/export-task dashboard-dogfood-final2-20260521 --zip/)).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: "/tmp/workerctl-dashboard-dogfood.png", fullPage: true });

  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText(/finish-task dashboard-dogfood-final2-20260521 --require-criteria-audit/)).toBeVisible({ timeout: 10000 });
});
