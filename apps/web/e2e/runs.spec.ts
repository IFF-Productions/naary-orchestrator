import { expect, test } from "@playwright/test";

/**
 * The core durable loop end-to-end: start a run, land on its detail paused for
 * approval, approve it, and watch it complete. Uses the seeded "default" graph
 * (start → humanApproval → end).
 */
test("start a run, approve it, and see it complete", async ({ page }) => {
  await page.goto("/app/runs");

  await page.getByRole("button", { name: "Start test run" }).click();

  // Lands on the run-detail view.
  await expect(page).toHaveURL(/\/app\/runs\/.+/);

  // The run pauses at the approval node → Approve button appears (polled state).
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible({ timeout: 15_000 });

  await approve.click();

  // After approval the run completes; the status reflects it and Approve is gone.
  await expect(page.getByText("Completed").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(approve).toBeHidden();

  // The execution log (curated Temporal history) shows the run's events.
  await expect(page.getByText("Execution log")).toBeVisible();
  await expect(page.getByText("Run started")).toBeVisible();
  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(page.getByText("Signal: approval")).toBeVisible();
});
