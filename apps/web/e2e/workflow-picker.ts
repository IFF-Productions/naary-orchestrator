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
 * TWO WAYS THIS FAILS, WANTING OPPOSITE RESPONSES.
 *
 *   A. THE CLICK IS SWALLOWED. `click()` waits for actionability — visible, stable, receives
 *      events — but not for React to have BOUND a handler. A click landing in that window is a
 *      silent no-op. Waiting longer never delivers it; only another click does.
 *
 *   B. THE DIALOG IS GATED ON DATA. Integrations renders `{tenant && <Dialog …>}`, and `tenant`
 *      arrives from `api.getMe()`. Click before that resolves and the state IS set — nothing
 *      renders. Another click changes nothing; only waiting does. The state is retained, so the
 *      dialog appears by itself the moment the data lands.
 *
 * The first version of this helper only knew about A: click, wait 5s, click once, wait 10s. On a
 * loaded CI stack that is 15s total, and B outlasted it — two clicks, fifteen seconds, no dialog,
 * and a re-run passing. So the loop below alternates: click, wait, click, wait, up to a budget
 * that covers a slow `getMe`, which serves A and B at once.
 *
 * REPEATED CLICKING IS SAFE HERE, and that is a property of these dialogs rather than a general
 * truth — worth stating, since a retry that can undo its own work is a real hazard:
 *   · the trigger is a SETTER (`onClick={() => setDialog("webhook")}`), not a toggle, so clicking
 *     twice cannot close what the first click opened;
 *   · once the dialog is up its overlay covers the trigger, and Playwright refuses to click an
 *     element that isn't the hit target — the click times out (swallowed below) instead of
 *     landing on the overlay, whose own handler WOULD close it.
 */
export async function openDialogWith(
  page: Page,
  trigger: string,
  dialogTitle: string,
  /**
   * Total time to spend trying. The old 5s+10s was 15s, which a loaded stack outlasted — so this
   * is deliberately longer, and the suite's per-test timeout was raised to leave room for it.
   */
  budgetMs = 25_000,
): Promise<void> {
  const title = page.getByText(dialogTitle, { exact: true });
  const button = page.getByRole("button", { name: trigger });
  const start = Date.now();
  const deadline = start + budgetMs;

  while (Date.now() < deadline) {
    // Check BEFORE clicking, every time. Not because a stray click would close it — it wouldn't,
    // see above — but because clicking a covered trigger burns the click timeout doing nothing,
    // which measurably delayed the open in testing.
    if (await title.isVisible().catch(() => false)) return;
    // Every wait is CLAMPED to what's left. Checking the deadline only at the top of the loop
    // would let one iteration run ~6s past it (click 3s + wait 3s), so a "25s budget" could spend
    // 31s and then report "never opened within 25000ms" — a number that was not true. The first
    // version of this did exactly that, and its own measurements said 27.2s.
    const clickBudget = Math.min(3_000, deadline - Date.now());
    if (clickBudget <= 0) break;
    // A short click timeout so a covered/not-yet-bound trigger costs a moment, not the budget.
    await button.click({ timeout: clickBudget }).catch(() => {});
    const waitBudget = Math.min(3_000, deadline - Date.now());
    if (waitBudget <= 0) break;
    const opened = await title
      .waitFor({ state: "visible", timeout: waitBudget })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }

  // Out of budget. Say WHICH thing never happened — "element(s) not found" on the picker inside
  // sends the reader after the wrong component, which is what this helper exists to prevent.
  // The time reported is what was actually SPENT, not what was asked for.
  const spentMs = Date.now() - start;
  const triggerVisible = await button.isVisible().catch(() => false);
  throw new Error(
    `"${dialogTitle}" never opened in the ${spentMs}ms after clicking "${trigger}". ` +
      (triggerVisible
        ? "The trigger is on screen, so either its handler never bound or the dialog's render is " +
          "still gated on data (Integrations renders it only once `getMe` resolves). Check the " +
          "stack logs for a slow or failed /me."
        : `The trigger "${trigger}" isn't even visible — the screen never finished rendering.`),
  );
}
