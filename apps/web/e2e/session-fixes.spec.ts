import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Regression e2e for the fixes made during the deploy/smoke-test session:
 *  1. Integration nodes are labeled by PROVIDER (a GitHub node reads "GitHub", not
 *     "Notion" — the last-registered integration tile). Guarded on BOTH the canvas
 *     and the (read-only) workflow-detail page, since each has its own render path.
 *  2. The canvas surfaces a "missing resource" warning when a node references a
 *     connection/config that isn't set (e.g. an integration node with no connection).
 *  3. The run-detail view shows the "Run input" payload that started the run.
 *  4. A workflow can be deleted from the Workflows list (button + confirm + removal).
 *
 * Runs against the live stack (docker compose up); auth + seeds come from global-setup.
 */

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";

/** The `nry_` token global-setup stashed in the storageState — used for in-test seeding. */
function apiToken(): string {
  const state = JSON.parse(readFileSync("./e2e/.auth/state.json", "utf8")) as {
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  const entry = state.origins[0]?.localStorage.find(
    (l) => l.name === "naary_api_token",
  );
  if (!entry) throw new Error("no naary_api_token in storageState");
  return entry.value;
}

test("canvas: an integration node is titled by its provider, not the shared type", async ({
  page,
}) => {
  await page.goto("/app/canvas");
  await expect(page.getByText("ADD NODE")).toBeVisible();

  // Place a GitHub integration tile. The palette button + the node share the accessible
  // name "GitHub" — scope the assertion to the react-flow node so we read the NODE label.
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  const ghNode = page
    .locator(".react-flow__node", { hasText: "GitHub" })
    .first();
  await expect(ghNode).toBeVisible();
  // The bug rendered EVERY integration node as "Notion" (last tile registered).
  await expect(
    page.locator(".react-flow__node", { hasText: "Notion" }),
  ).toHaveCount(0);

  // And a second, different provider is labeled distinctly (proves it's config-driven).
  await page.getByRole("button", { name: "Notion", exact: true }).click();
  await expect(
    page.locator(".react-flow__node", { hasText: "Notion" }),
  ).toBeVisible();
});

test("workflow detail: a saved GitHub integration node reads 'GitHub'", async ({
  page,
}) => {
  // Reproduces the reported bug on the exact surface the user hit: the read-only
  // workflow-detail page (its own ViewNode render path, separate from the canvas).
  await page.goto("/app/workflows/e2e-integration");
  await expect(page.getByText("GitHub").first()).toBeVisible();
  await expect(page.getByText("Notion")).toHaveCount(0);
});

test("canvas: an integration node with no connection shows an issue warning", async ({
  page,
}) => {
  await page.goto("/app/canvas");
  await expect(page.getByText("ADD NODE")).toBeVisible();

  // A freshly placed GitHub tile has no connection → the canvas flags an issue. Since PR #242
  // the two warning pills were merged into ONE clickable "⚠ N issues" pill whose details live
  // in a collapsible panel — so assert the pill, then expand it to see the specific reason.
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  const issuesPill = page.getByRole("button", { name: /\d+ issue/i });
  await expect(issuesPill).toBeVisible();
  await issuesPill.click();
  await expect(
    page.getByText(/needs a connection|which doesn't exist/i).first(),
  ).toBeVisible();
});

test("run detail: the 'Run input' panel shows the payload that started the run", async ({
  page,
}) => {
  // e2e-nodes' Start node carries a distinctive sampleInput (seeded by global-setup),
  // which becomes ctx.__input for the run.
  await page.goto("/app/workflows/e2e-nodes");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/app\/runs\/.+/);

  await expect(page.getByText("Run input")).toBeVisible();
  // The seeded payload is rendered in the panel (proves it's the real trigger input).
  await expect(page.getByText(/NAARY-42/)).toBeVisible();
});

test("webhook registration: pick the workflow from a dropdown of saved workflows", async ({
  page,
}) => {
  await page.goto("/app/integrations");

  // Open the (collapsed-by-default) webhook register form.
  await page.getByRole("button", { name: /Register a webhook/ }).click();

  // The workflow is now a SELECT populated with real saved workflows — not a free-text
  // field (typing an unsaved/typo key was the "No graph seeded for '…'" 404 footgun).
  const workflowSelect = page.locator("select", {
    has: page.locator('option[value="default"]'),
  });
  await expect(workflowSelect).toBeVisible();
  // Seeded workflows appear as options (label shows the name + key).
  await expect(
    workflowSelect.locator('option[value="e2e-integration"]'),
  ).toHaveCount(1);

  // Choosing one enables Register and the registration succeeds.
  await workflowSelect.selectOption("default");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText("Trigger it (copy & run)")).toBeVisible();
});

test("workflows list: a workflow can be deleted", async ({ page }) => {
  // Create a throwaway workflow via the API so the test is self-contained and
  // survives retries (a fresh key each run — nothing to leak between attempts).
  const key = `e2e-del-${Date.now()}`;
  const name = `Deletable ${key}`;
  const res = await page.request.post(`${API_BASE}/graphs`, {
    headers: { authorization: `Bearer ${apiToken()}` },
    data: {
      workflowKey: key,
      name,
      graph: {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          { id: "e", type: "end" },
        ],
        edges: [{ from: "s", to: "e" }],
      },
    },
  });
  expect(res.ok()).toBeTruthy();

  // The Delete button pops a window.confirm — auto-accept it.
  page.on("dialog", (d) => d.accept());

  await page.goto("/app/workflows");
  const row = page.locator(".run-row", { hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Delete", exact: true }).click();

  // The row disappears (optimistic removal), and it's gone after a reload too.
  await expect(page.locator(".run-row", { hasText: name })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".run-row", { hasText: name })).toHaveCount(0);
});
