import { expect, test } from "@playwright/test";

/**
 * The node types added after the initial suite (set / merge / wait / stopAndError /
 * executeSubWorkflow). Two levels:
 *  1. Authoring — each node is placeable from the palette and opens its own config
 *     inspector (a distinctive field per type).
 *  2. Run-through — a seeded graph using the new nodes (set → merge → wait) runs to
 *     completion through the real interpreter (global-setup seeds "e2e-nodes").
 */

// palette label → a distinctive label rendered in that node's config inspector.
const NEW_NODES = [
  { label: "Edit Fields", field: "Static fields (JSON)" },
  { label: "Rename Keys", field: "Drop keys (JSON array)" },
  { label: "Filter", field: "Item path" },
  { label: "Aggregate", field: "Operation" },
  { label: "Date & Time", field: "Add seconds (may be negative)" },
  { label: "Merge", field: "Combine mode" },
  { label: "Wait", field: "Wait (seconds)" },
  { label: "Stop & Error", field: "Error message" },
  { label: "Sub-workflow", field: "Sub-workflow key" },
  { label: "HMAC", field: "Algorithm" },
  { label: "JWT", field: "Expires in (seconds, optional)" },
  { label: "TOTP", field: "Period (seconds)" },
  { label: "Send Email", field: "SMTP connection id" },
];

for (const n of NEW_NODES) {
  test(`canvas: place the ${n.label} node and open its config`, async ({
    page,
  }) => {
    await page.goto("/app/canvas");
    await expect(page.getByText("ADD NODE")).toBeVisible();

    // Add from the palette (a <button>); the node renders as a react-flow div.
    await page.getByRole("button", { name: n.label, exact: true }).click();
    const node = page
      .locator(".react-flow__node", { hasText: n.label })
      .first();
    await expect(node).toBeVisible();

    // Selecting it opens the inspector with this node type's own config field.
    await node.click();
    await expect(page.getByText("Edit node")).toBeVisible();
    await expect(page.getByText(n.field)).toBeVisible();

    // Delete via the modal; it closes.
    await page.getByRole("button", { name: "Delete node" }).click();
    await expect(page.getByText("Edit node")).toBeHidden();
  });
}

test("run-through: a graph using set → merge → wait completes end-to-end", async ({
  page,
}) => {
  // The "e2e-nodes" workflow is seeded by global-setup: start fans out to two set
  // nodes → merge → dateTime → renameKeys → wait → end. No LLM key, no approval —
  // it runs to completion, exercising set/merge/dateTime/renameKeys/wait in the
  // real Temporal interpreter.
  await page.goto("/app/workflows/e2e-nodes");
  await page.getByRole("button", { name: "Run now" }).click();

  // Lands on the run-detail view and completes (the wait is ~1s).
  await expect(page).toHaveURL(/\/app\/runs\/.+/);
  await expect(page.getByText("Completed").first()).toBeVisible({
    timeout: 20_000,
  });
});
