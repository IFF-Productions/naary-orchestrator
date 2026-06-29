import { expect, test } from "@playwright/test";

/**
 * Using a template loads its graph into the canvas as a NEW draft (forked) —
 * previously this 404'd because the canvas tried to open it as a saved workflow.
 */
test("use a template forks it into the canvas", async ({ page }) => {
  await page.goto("/app/templates");

  await page.getByRole("button", { name: "Use template" }).first().click();

  await expect(page).toHaveURL(/\/app\/canvas\?template=/);
  // The template graph loaded (nodes rendered) + the forked status shows.
  await expect(page.getByText(/Forked from template/)).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});
