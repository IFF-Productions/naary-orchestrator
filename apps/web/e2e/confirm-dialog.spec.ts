import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { confirmDialog, dismissConfirm } from "./confirm";

/**
 * The in-app confirm dialog that replaced `window.confirm`, exercised on a real destructive action
 * (workflow delete).
 *
 * The DECLINE path is the point of this spec. With `window.confirm` nothing ever tested it: a spec
 * either auto-accepted or the dialog blocked the run. So "does saying no actually abort?" was
 * unverified on every destructive action in the app — and a confirm that deletes anyway is a
 * data-loss bug, not a UI nit. It's also the exact failure a naive promise implementation produces
 * (resolving true on dismiss, or resolving nothing and letting the handler continue).
 *
 * Escape and backdrop dismissal are covered too, since both are wired to the same "no" and a
 * regression in either silently upgrades a cancel into a delete.
 *
 * The ACCEPT path is not repeated here — session-fixes.spec.ts's "a workflow can be deleted" already
 * drives it through `acceptConfirm`, and each of these tests seeds a real workflow, so duplicating it
 * would just cost CI time.
 */

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";

/** The `nry_` token global-setup stashed in the storageState - used for in-test seeding. */
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

/** Create a throwaway workflow via the API. A fresh key per call, so retries can't collide. */
async function makeWorkflow(
  page: Page,
  tag: string,
): Promise<{ key: string; name: string }> {
  const key = `e2e-confirm-${tag}-${Date.now()}`;
  const name = `Confirm ${key}`;
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
  return { key, name };
}

/** Navigate to a workflow's detail screen and click its Delete button (opens the confirm). */
async function openDeleteConfirm(
  page: Page,
  key: string,
  name: string,
): Promise<void> {
  await page.goto("/app/workflows");
  const row = page.locator(".run-row", { hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/workflows/${key}$`));
  // `exact` so this matches the trigger and not the dialog's "Delete workflow" accept button.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
}

/** The workflow still exists (its row is on the list after a reload). */
async function expectStillExists(
  page: Page,
  name: string,
): Promise<void> {
  await page.goto("/app/workflows");
  await page.reload();
  await expect(page.locator(".run-row", { hasText: name })).toHaveCount(1);
}

test("declining the confirm does NOT delete the workflow", async ({ page }) => {
  const { key, name } = await makeWorkflow(page, "cancel");
  await openDeleteConfirm(page, key, name);

  // The question names the resource, so the reader can tell WHAT they're deleting.
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText(name);
  await dismissConfirm(page);

  // Still on the detail screen (no navigation), and the workflow survives a reload.
  await expect(page).toHaveURL(new RegExp(`/app/workflows/${key}$`));
  await expectStillExists(page, name);
});

test("Escape dismisses the confirm and aborts the delete", async ({ page }) => {
  const { key, name } = await makeWorkflow(page, "esc");
  await openDeleteConfirm(page, key, name);

  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toBeHidden();
  await expectStillExists(page, name);
});

test("clicking the backdrop aborts the delete", async ({ page }) => {
  const { key, name } = await makeWorkflow(page, "backdrop");
  await openDeleteConfirm(page, key, name);

  // Click the overlay itself, well away from the panel (the panel stops propagation).
  await page.locator('[data-testid="confirm-dialog"]').click({
    position: { x: 5, y: 5 },
  });
  await expect(confirmDialog(page)).toBeHidden();
  await expectStillExists(page, name);
});

test("a destructive confirm opens with Cancel focused, so a stray Enter is safe", async ({
  page,
}) => {
  const { key, name } = await makeWorkflow(page, "focus");
  await openDeleteConfirm(page, key, name);

  // Focus starts on the SAFE choice for danger actions — pressing Enter must cancel, not delete.
  await expect(confirmDialog(page).getByTestId("confirm-cancel")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirmDialog(page)).toBeHidden();
  await expectStillExists(page, name);
});
