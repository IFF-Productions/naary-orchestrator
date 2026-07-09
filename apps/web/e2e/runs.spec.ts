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

test("re-run a completed run inline from the Runs list", async ({ page }) => {
  // Produce a terminal run deterministically: the seeded e2e-nodes graph (no
  // approval, no LLM) runs to completion in ~1s.
  await page.goto("/app/workflows/e2e-nodes");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/app\/runs\/.+/);
  await expect(page.getByText("Completed").first()).toBeVisible({
    timeout: 20_000,
  });
  const originalUrl = page.url();

  // On the Runs list, a completed row exposes an inline Re-run action.
  await page.goto("/app/runs");
  await page.getByRole("button", { name: "Completed" }).click(); // filter tab
  const rerun = page
    .getByRole("button", { name: "Re-run with the same input" })
    .first();
  await expect(rerun).toBeVisible();
  await rerun.click();

  // It starts a NEW run and navigates to it.
  await expect(page).toHaveURL(/\/app\/runs\/.+/);
  expect(page.url()).not.toBe(originalUrl);
});
