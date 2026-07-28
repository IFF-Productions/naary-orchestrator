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

  // The run pauses at the approval node → the calm paused hero's decide-in-place
  // button appears (polled state).
  const approve = page.getByRole("button", { name: "Approve & resume" });
  await expect(approve).toBeVisible({ timeout: 15_000 });

  await approve.click();

  // After approval the run completes; the status reflects it and Approve is gone.
  await expect(page.getByText("Run completed").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(approve).toBeHidden();

  // The log panel (curated Temporal history) shows the run's events. exact — the sidebar's
  // "Insights & logs" nav link otherwise substring-matches. The panel heading is
  // "Execution log" (RunDetail restructure, #525).
  await expect(page.getByText("Execution log", { exact: true })).toBeVisible();

  // SCOPED to the log card. "Run completed" appears TWICE on this page — once as the hero's
  // status and once as a log event — so an unscoped `getByText` is a strict-mode violation the
  // moment both are rendered. The assertion above already used `.first()` for the hero, which
  // means the ambiguity was known; this one was missed and failed intermittently in CI.
  //
  // Scoping says what the assertion actually means (the LOG lists these events) instead of
  // silencing the error with another `.first()`, which would have passed on the hero and stopped
  // checking the log at all.
  const log = page
    .locator(".card")
    .filter({ has: page.getByText("Execution log", { exact: true }) })
    .last();
  await expect(log.getByText("Run started")).toBeVisible();
  await expect(log.getByText("Run completed")).toBeVisible();
  await expect(log.getByText("Signal: approval")).toBeVisible();
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
