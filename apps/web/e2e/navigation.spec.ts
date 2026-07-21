import { expect, test } from "@playwright/test";

/** Sidebar navigation reaches each operate screen (asserting a screen-unique element). */
test("sidebar navigates to the operate screens", async ({ page }) => {
  await page.goto("/app");

  // Scope to the sidebar nav landmark — screens can now carry their own links to the same
  // routes (e.g. Overview's "All workflows →"), so an unscoped by-name link is ambiguous.
  const nav = page.getByRole("navigation", { name: "Primary" });

  await nav.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workflows$/);
  await expect(page.getByPlaceholder("Filter by name…")).toBeVisible();
  // Real data through the proxy: the seeded workflow appears in the list.
  await expect(page.getByText("E2E flow").first()).toBeVisible();

  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/runs$/);
  await expect(
    page.getByRole("button", { name: "Start test run" }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Schedules", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/schedules$/);
  await expect(page.getByText("New schedule").first()).toBeVisible();
});
