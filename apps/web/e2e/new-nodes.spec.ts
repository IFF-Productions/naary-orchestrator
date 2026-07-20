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
  { label: "Error Trigger", field: "Error handler entry" },
  { label: "Edit Fields", field: "Static fields (JSON)" },
  { label: "Rename Keys", field: "Drop keys (JSON array)" },
  { label: "Filter", field: "Item path" },
  { label: "Aggregate", field: "Operation" },
  { label: "Compare Datasets", field: "Key field (identifies a row)" },
  { label: "XML", field: "Operation" },
  { label: "List Ops", field: "Count (limit)" },
  { label: "Date & Time", field: "Add seconds (may be negative)" },
  { label: "Merge", field: "Combine mode" },
  { label: "Wait", field: "Wait (seconds)" },
  { label: "Stop & Error", field: "Error message" },
  { label: "Respond", field: "Status code" },
  { label: "Code", field: "JavaScript" },
  { label: "Sub-workflow", field: "Sub-workflow key" },
  { label: "For Each", field: "Sub-workflow key (run per item)" },
  { label: "HMAC", field: "Algorithm" },
  { label: "JWT", field: "Expires in (seconds, optional)" },
  { label: "TOTP", field: "Period (seconds)" },
  { label: "Send Email", field: "SMTP connection id" },
  { label: "RSS Read", field: "Feed URL (https)" },
  { label: "GraphQL", field: "Endpoint URL" },
];

for (const n of NEW_NODES) {
  test(`canvas: place the ${n.label} node and open its config`, async ({
    page,
  }) => {
    await page.goto("/app/canvas");

    // Add via the full catalog modal (the rail's dashed "+"): search, then Add.
    await page.getByRole("button", { name: "Browse all nodes" }).click();
    await page.getByLabel("Search nodes").fill(n.label);
    await page
      .getByRole("button", { name: `Add ${n.label} to canvas`, exact: true })
      .click();
    const node = page
      .locator(".react-flow__node", { hasText: n.label })
      .first();
    await expect(node).toBeVisible();

    // Selecting it fills the dock with this node type's own config field.
    await node.click();
    await expect(page.getByText("Parameters", { exact: true })).toBeVisible();
    // .first(): some field labels (e.g. "JavaScript") also appear in a select's
    // options, so the label text matches more than one node — presence is enough.
    await expect(page.getByText(n.field).first()).toBeVisible();

    // Delete via the dock header; the dock returns to its empty state.
    await page.getByRole("button", { name: "Delete node" }).click();
    await expect(page.getByText("Select a node to configure it")).toBeVisible();
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

test("category rail + catalog search filter the node list", async ({
  page,
}) => {
  await page.goto("/app/canvas");
  // Category tiles render on the icon rail.
  await expect(
    page.getByRole("button", { name: "Transform", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Control flow", exact: true }),
  ).toBeVisible();
  // A rail tile opens its category popover listing that category's nodes.
  await page.getByRole("button", { name: "Transform", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Edit Fields", exact: true }),
  ).toBeVisible();
  // The catalog modal's search narrows to matching nodes.
  await page.getByRole("button", { name: "Browse all nodes" }).click();
  await page.getByLabel("Search nodes").fill("jwt");
  await expect(
    page.getByRole("button", { name: "Add JWT to canvas", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Filter to canvas", exact: true }),
  ).toHaveCount(0);
});
