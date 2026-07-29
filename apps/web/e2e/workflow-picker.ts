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
  await expect(picker).toBeVisible({ timeout: 20_000 });
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
