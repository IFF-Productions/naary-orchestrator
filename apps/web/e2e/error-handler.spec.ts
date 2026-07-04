import { expect, test } from "@playwright/test";

// The "Error workflow" binding on a workflow's detail page (Slice 2). global-setup
// seeds two workflows: "default" and "e2e-nodes".
test("workflow detail: bind, persist, and clear an error workflow", async ({
  page,
}) => {
  await page.goto("/app/workflows/e2e-nodes");
  await expect(page.getByText("Error workflow")).toBeVisible();

  const select = page.getByLabel("Error workflow");
  await expect(select).toBeVisible();
  // a workflow can't be its own handler — excluded from the options
  await expect(select.locator('option[value="e2e-nodes"]')).toHaveCount(0);

  // bind to "default" and confirm it PERSISTS across a reload (hit the API)
  await select.selectOption("default");
  await expect(select).toHaveValue("default");
  await page.reload();
  await expect(page.getByLabel("Error workflow")).toHaveValue("default");

  // clear it back to none (leave state clean for reruns)
  await page.getByLabel("Error workflow").selectOption("");
  await page.reload();
  await expect(page.getByLabel("Error workflow")).toHaveValue("");
});
