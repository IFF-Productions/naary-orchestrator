import { expect, test } from "@playwright/test";

/**
 * Schedules: create a recurring schedule for the seeded workflow, then pause and
 * delete it. Uses a unique cron so the row is targetable even if earlier runs
 * left schedules behind, and cleans itself up.
 */
test("create, pause, and delete a schedule", async ({ page }) => {
  const cron = "15 3 * * 1"; // distinctive: Mondays 03:15

  await page.goto("/app/schedules");

  // Create for the seeded "default" workflow.
  await page.getByRole("combobox").selectOption("default");
  await page.getByPlaceholder("0 9 * * 1-5").fill(cron);
  await page.getByRole("button", { name: "Create" }).click();

  // The new row shows up (scoped by the unique cron).
  const row = page.getByTestId("schedule-row").filter({ hasText: cron });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Active");

  // Pause → the row flips to Paused.
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row).toContainText("Paused");

  // Delete → the row is gone.
  await row.getByRole("button", { name: "Delete schedule" }).click();
  await expect(
    page.getByTestId("schedule-row").filter({ hasText: cron }),
  ).toHaveCount(0);
});
