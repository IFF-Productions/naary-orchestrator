import { expect, test } from "@playwright/test";

/**
 * Installing a template saves it as a real workflow (unique key) and the
 * success view's "Open in canvas" opens that saved workflow.
 */
test("install a template and open it in the canvas", async ({ page }) => {
  await page.goto("/app/templates");

  // Open the first template's preview, then install it.
  await page
    .getByRole("button", { name: /^Preview / })
    .first()
    .click();
  await page.getByRole("button", { name: "Install template" }).click();

  // The install-success walkthrough appears.
  await expect(page.getByText(/installed/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // Open in canvas → the SAVED workflow (?key=…), nodes render.
  await page.getByRole("button", { name: "Open in canvas" }).click();
  await expect(page).toHaveURL(/\/app\/canvas\?key=/);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});
