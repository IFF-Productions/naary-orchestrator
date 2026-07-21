import { expect, test } from "@playwright/test";

/**
 * Schedules: create a recurring schedule for the seeded workflow, then pause and
 * delete it. Uses a unique cron so the row is targetable even if earlier runs
 * left schedules behind, and cleans itself up.
 */
test("create, pause, and delete a schedule", async ({ page }) => {
  const cron = "15 3 * * 1"; // distinctive: Mondays 03:15

  await page.goto("/app/schedules");

  // Create for the seeded "default" workflow (the create flow lives in a dialog). first() —
  // when the list is empty the screen shows both a header and an empty-state "New schedule".
  await page.getByRole("button", { name: "New schedule" }).first().click();
  await page.getByRole("combobox").selectOption("default");
  await page.getByPlaceholder("0 9 * * 1-5").fill(cron);
  await page.getByRole("button", { name: "Create schedule" }).click();

  // The new row shows up (scoped by the unique cron).
  const row = page.getByTestId("schedule-row").filter({ hasText: cron });
  await expect(row).toBeVisible();

  // Pause via the pill switch → the row shows the paused state.
  await row.getByRole("switch").click();
  await expect(row).toContainText("paused");

  // Delete → the row is gone.
  await row.getByRole("button", { name: /Delete the .* schedule/ }).click();
  await expect(
    page.getByTestId("schedule-row").filter({ hasText: cron }),
  ).toHaveCount(0);
});
