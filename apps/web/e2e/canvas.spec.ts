import { expect, test } from "@playwright/test";

/**
 * Canvas: add a node from the palette, open its config inspector (modal), and
 * delete it — exercising the inspector-v2 + node-delete features.
 */
test("add an agent node, edit it in the modal, delete it", async ({ page }) => {
  await page.goto("/app/canvas");

  await expect(page.getByText("ADD NODE")).toBeVisible();

  // Add an Agent node from the palette (a <button>); the node is a div.
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const agentNode = page.locator(".react-flow__node", { hasText: "Agent" });
  await expect(agentNode).toBeVisible();

  // Selecting it opens the inspector modal with the agent config fields.
  await agentNode.click();
  await expect(page.getByText("Edit node")).toBeVisible();
  await expect(page.getByText("Provider").first()).toBeVisible();
  // "Model" appears in the field label + the select's options → match the first.
  await expect(page.getByText("Model").first()).toBeVisible();

  // Delete it via the modal; the modal closes and the node is gone.
  await page.getByRole("button", { name: "Delete node" }).click();
  await expect(page.getByText("Edit node")).toBeHidden();
  await expect(agentNode).toHaveCount(0);
});
