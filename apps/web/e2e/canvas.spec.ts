import { expect, test } from "@playwright/test";

/**
 * Canvas (three-pane redesign): add a node from the category rail's popover,
 * open its config in the inspector dock, and delete it from the dock header.
 */
test("add an agent node, edit it in the dock, delete it", async ({ page }) => {
  await page.goto("/app/canvas");

  // The icon rail is the canvas's ready sentinel.
  await expect(
    page.getByRole("button", { name: "Browse all nodes" }),
  ).toBeVisible();

  // Add an Agent node from the "AI & Agents" rail popover; the node is a div.
  await page.getByRole("button", { name: "AI & Agents", exact: true }).click();
  await page.getByRole("menuitem", { name: "Agent", exact: true }).click();
  const agentNode = page.locator(".react-flow__node", { hasText: "Agent" });
  await expect(agentNode).toBeVisible();

  // Selecting it fills the inspector dock with the agent's parameters.
  await agentNode.click();
  await expect(page.getByText("Parameters", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider").first()).toBeVisible();
  // "Model" appears in the field label + the select's options → match the first.
  await expect(page.getByText("Model").first()).toBeVisible();

  // Delete it via the dock header trash; the dock empties and the node is gone.
  await page.getByRole("button", { name: "Delete node" }).click();
  await expect(page.getByText("Select a node to configure it")).toBeVisible();
  await expect(agentNode).toHaveCount(0);
});
