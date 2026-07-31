import { expect, type Page } from "@playwright/test";

/**
 * Drive the endpoint-registration WORKFLOW PICKER (Integrations → New webhook / form / chat).
 *
 * It used to be a native `<select>`, so specs did `selectOption("default")`. It is now a
 * FILTERABLE combobox (an input + a listbox of buttons) because a tenant can have hundreds of
 * workflows and forms/chat only offer the ones whose entry node matches. Options carry
 * `data-workflow-key` for exactly this: the visible label is the workflow NAME, but a test
 * knows the KEY.
 */
/**
 * Wait for the picker to be READY, not merely present.
 *
 * It renders disabled while `/api/graphs` is in flight. Clicking straight away spends the test's
 * whole 30s budget inside `locator.click()` and then reports a click timeout — which names the
 * wrong thing: the list was slow, the click was fine. Asserting enabled first fails with
 * "expected enabled" and its own budget, so a slow stack is distinguishable from a broken picker.
 */
async function readyPicker(page: Page) {
  const picker = page.getByTestId("workflow-picker");
  const empty = page.getByTestId("workflow-picker-empty");

  // Wait for EITHER outcome, then say which. The picker renders as the control (loading or
  // ready) or as an empty-state div — never both. Asserting only on the control meant an empty
  // list burned the whole budget and failed with `element(s) not found`, which reads as "the
  // picker is broken" when the truth is "this workspace has no eligible workflows" — in CI,
  // that the seed didn't land. Racing them turns a 20s mystery into a one-line answer.
  await expect(picker.or(empty)).toBeVisible({ timeout: 20_000 });
  if (await empty.isVisible()) {
    throw new Error(
      `The workflow picker rendered its EMPTY state (${await empty.getAttribute("data-empty")}), ` +
        "so there was nothing to choose. The picker itself is fine — the workspace has no " +
        `eligible workflows. Check the e2e seed. Copy: "${(await empty.innerText()).trim()}"`,
    );
  }
  await expect(picker).toBeEnabled({ timeout: 20_000 });
  return picker;
}

export async function pickWorkflow(page: Page, workflowKey: string) {
  const picker = await readyPicker(page);
  await picker.click(); // opens the listbox
  // Type to filter — also proves the filtering works, which is the point of the combobox.
  await picker.fill(workflowKey);
  const option = page.locator(
    `[role="option"][data-workflow-key="${workflowKey}"]`,
  );
  await expect(option).toBeVisible();
  await option.click();
}

/** Assert a workflow is OFFERED by the picker (without selecting it). */
export async function expectWorkflowOffered(page: Page, workflowKey: string) {
  const picker = await readyPicker(page);
  await picker.click();
  await picker.fill(workflowKey);
  await expect(
    page.locator(`[role="option"][data-workflow-key="${workflowKey}"]`),
  ).toHaveCount(1);
}

/**
 * Open a dialog that CONTAINS a workflow picker, and don't continue until it is actually open.
 *
 * `click()` waits for actionability — visible, stable, receives events — but not for React to have
 * BOUND a handler to the button. A click that lands in that window is a silent no-op: the dialog
 * never opens, and the next assertion waits its full budget for a picker that was never mounted.
 * It fails with `element(s) not found`, which points at the picker; the picker is fine.
 *
 * That is exactly how it presented on main: `webhook-howto` failed and `session-fixes` was FLAKY —
 * same helper, same symptom, one of them passing on retry. 60 other specs passed, so nothing was
 * broken; the click was simply early.
 *
 * So: click, confirm the dialog, and click ONCE more if it didn't open. A retry rather than a
 * longer timeout, because waiting longer does not deliver a click that never registered.
 */
export async function openDialogWith(
  page: Page,
  trigger: string,
  dialogTitle: string,
): Promise<void> {
  const title = page.getByText(dialogTitle, { exact: true });
  await page.getByRole("button", { name: trigger }).click();
  try {
    await expect(title).toBeVisible({ timeout: 5_000 });
  } catch {
    // The first click was swallowed. One retry, then let the assertion speak for itself.
    await page.getByRole("button", { name: trigger }).click();
    await expect(title).toBeVisible({ timeout: 10_000 });
  }
}
