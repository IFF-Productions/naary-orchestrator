import { expect, test } from "@playwright/test";

/**
 * Save round-trip: rename the canvas draft and save it, then confirm it shows up
 * in the Workflows list (exercises compile → POST /graphs → listGraphs).
 */
test("rename and save a workflow; it appears in Workflows", async ({
  page,
}) => {
  const name = "E2E Saved Flow";

  await page.goto("/app/canvas");
  await page.getByPlaceholder("Workflow name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText(/Saved as/)).toBeVisible();

  // Round-trips through the API → appears in the saved-workflows list.
  await page.goto("/app/workflows");
  await expect(page.getByText(name).first()).toBeVisible();
});
