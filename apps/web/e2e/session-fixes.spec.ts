import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { acceptConfirm } from "./confirm";
import { expectWorkflowOffered, pickWorkflow } from "./workflow-picker";

/**
 * Regression e2e for the fixes made during the deploy/smoke-test session:
 *  1. Integration nodes are labeled by PROVIDER (a GitHub node reads "GitHub", not
 *     "Notion" — the last-registered integration tile). Guarded on BOTH the canvas
 *     and the (read-only) workflow-detail page, since each has its own render path.
 *  2. The canvas surfaces a "missing resource" warning when a node references a
 *     connection/config that isn't set (e.g. an integration node with no connection).
 *  3. The run-detail view shows the "Run input" payload that started the run.
 *  4. A workflow can be deleted from its detail screen (row click → Delete + confirm).
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

  // Place a GitHub integration tile from the rail's Integrations popover. The popover
  // item + the node share the accessible name "GitHub" — scope the assertion to the
  // react-flow node so we read the NODE label.
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await page.getByRole("menuitem", { name: "GitHub", exact: true }).click();
  const ghNode = page
    .locator(".react-flow__node", { hasText: "GitHub" })
    .first();
  await expect(ghNode).toBeVisible();
  // The bug rendered EVERY integration node as "Notion" (last tile registered).
  await expect(
    page.locator(".react-flow__node", { hasText: "Notion" }),
  ).toHaveCount(0);

  // And a second, different provider is labeled distinctly (proves it's config-driven).
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await page.getByRole("menuitem", { name: "Notion", exact: true }).click();
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

  // A freshly placed GitHub tile has no connection → the canvas flags an issue. Since PR #242
  // the two warning pills were merged into ONE clickable "⚠ N issues" pill whose details live
  // in a collapsible panel — so assert the pill, then expand it to see the specific reason.
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await page.getByRole("menuitem", { name: "GitHub", exact: true }).click();
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

  // Let the run settle so the timeline is stable. The default step selection FOLLOWS
  // the run (state.currentNodeId), which on a completed run is the end node — so we
  // can't rely on catching the sub-second window where the Start node is current.
  await expect(page.getByText("Completed").first()).toBeVisible({
    timeout: 15_000,
  });

  // Explicitly select the Start (trigger) step. Its panel shows the entry payload as
  // "Trigger input" — the start node PUBLISHES the run input as its own output, like every
  // other entry node. (Deterministic: not a race on which node is current.)
  await page.getByRole("button", { name: /Start/ }).click();

  // The redesigned run detail shows the entry payload as the trigger step's "Trigger input".
  await expect(page.getByText("Trigger input")).toBeVisible();
  // The seeded payload is rendered there (proves it's the real trigger input).
  await expect(page.getByText(/NAARY-42/)).toBeVisible();
});

test("webhook registration: pick the workflow from a dropdown of saved workflows", async ({
  page,
}) => {
  await page.goto("/app/integrations?tab=webhooks");

  // Open the webhook registration dialog ("New webhook" → "Register a webhook").
  await page.getByRole("button", { name: "New webhook" }).click();

  // The workflow is CHOSEN from real saved workflows — never free text (typing an unsaved or
  // typo'd key was the "No graph seeded for '…'" 404 footgun). It is a filterable combobox now,
  // because a tenant can have hundreds and a plain select can't be searched.
  await expectWorkflowOffered(page, "e2e-integration");

  // Choosing one enables Register and the registration succeeds.
  await pickWorkflow(page, "default");
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

  // Redesign: Delete lives on the DETAIL screen (row click opens it).
  await page.goto("/app/workflows");
  const row = page.locator(".run-row", { hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/workflows/${key}$`));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  // Delete now asks in-app, not via window.confirm — accept, and pin the wording so the button
  // keeps naming the action rather than regressing to a bare "OK".
  await acceptConfirm(page, "Delete workflow");

  // Deleting navigates back to the list, where the row is gone (reload too).
  await expect(page).toHaveURL(/\/app\/workflows$/);
  await expect(page.locator(".run-row", { hasText: name })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".run-row", { hasText: name })).toHaveCount(0);
});
