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

/**
 * The preview renders the template's graph READ-ONLY (#574 AC) — against the REAL API, so
 * the graph under test is the shipped seed graph, not a fixture.
 *
 * This lives in the e2e suite rather than as a Storybook `play` assertion on purpose:
 * nothing in CI executes story play functions (there is no test-runner wired up), so a
 * failing assertion there would render as an error panel nobody sees. The stories are
 * reproduction fixtures for a human; this is the gate.
 *
 * The supervisor template is the one worth gating because it is the branching case — it
 * proves the diagram reports structure (a fan-out) and labels each conditional edge with
 * the target it routes to, rather than drawing every template as a straight line.
 */
test("the template preview renders the graph read-only, branches and all", async ({
  page,
}) => {
  await page.goto("/app/templates");

  await page
    .getByRole("button", { name: /^Preview Supervisor & specialist agents/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The diagram is lazily imported (it pulls the react-flow chunk), so wait for nodes
  // rather than asserting immediately.
  const nodes = dialog.locator(".react-flow__node");
  await expect(nodes.first()).toBeVisible({ timeout: 15_000 });
  // 7 nodes: webhook → supervisor → 3 specialists → respond → end.
  await expect(nodes).toHaveCount(7);

  // Each of the three handoff edges is labelled with the specialist it routes to — the
  // whole point of rendering the graph instead of a linear step list.
  const labels = dialog.locator(".react-flow__edge-text");
  await expect(labels.filter({ hasText: "billing_specialist" })).toHaveCount(1);
  await expect(labels.filter({ hasText: "technical_specialist" })).toHaveCount(
    1,
  );
  await expect(labels.filter({ hasText: "general_specialist" })).toHaveCount(1);

  // The diagram and the header's node count come from different places (the rendered graph
  // vs. the catalog's `nodeCount`); tying them together catches a diagram that silently
  // drops nodes as well as a catalog count that drifts from its graph.
  await expect(dialog).toContainText("7 nodes");
});

/**
 * Honest data on the preview: a WRITE-mode codeAgent node must not be described as
 * "read-only" (it clones a repo and can open a pull request). Guards the shared
 * `nodeSubtitle`, which the canvas and the run views render too.
 */
test("a write-mode code agent is not labelled read-only", async ({ page }) => {
  await page.goto("/app/templates");

  await page
    .getByRole("button", {
      name: /^Preview Issue . approved plan . pull request/,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".react-flow__node").first()).toBeVisible({
    timeout: 15_000,
  });

  // Assert the node SUBTITLE, not just the word "write" — the description already says the
  // agent "writes the plan", so a bare `toContainText("write")` would pass even with the
  // old hardcoded label. `claude · write · <repo>` is produced only by the write path.
  await expect(dialog).toContainText("your-org/your-repo");
  await expect(dialog).not.toContainText("read-only");
  // Both outcomes of the "is this safe to attempt?" decision are drawn.
  const labels = dialog.locator(".react-flow__edge-text");
  await expect(labels.filter({ hasText: "attempt" })).toHaveCount(2);
});
