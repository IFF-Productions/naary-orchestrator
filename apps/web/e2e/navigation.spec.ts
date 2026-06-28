import { expect, test } from "@playwright/test";

/** Sidebar navigation reaches each operate screen (asserting a screen-unique element). */
test("sidebar navigates to the operate screens", async ({ page }) => {
  await page.goto("/app");

  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/\/app\/workflows$/);
  await expect(page.getByPlaceholder("Filter by name…")).toBeVisible();
  // Real data through the proxy: the seeded workflow appears in the list.
  await expect(page.getByText("E2E flow").first()).toBeVisible();

  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/\/app\/runs$/);
  await expect(
    page.getByRole("button", { name: "Start test run" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page).toHaveURL(/\/app\/schedules$/);
  await expect(page.getByText("New schedule")).toBeVisible();
});
