import { expect, test } from "@playwright/test";

/**
 * Opening a workflow shows the read-only decision-tree diagram + a "How it runs"
 * explainer (BUGS.md #3/#4).
 */
test("workflow detail renders the diagram and how-it-runs", async ({
  page,
}) => {
  await page.goto("/app/workflows");

  // Open the first saved workflow (row click → detail view).
  await page.locator(".run-row").first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[^/]+$/);

  // The graph renders (read-only react-flow nodes) + the explainer + actions.
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.getByText("How it runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open in canvas" }),
  ).toBeVisible();
});
