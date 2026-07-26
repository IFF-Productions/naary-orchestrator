import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the in-app confirm dialog (`src/components/confirm.tsx`), which replaced
 * `window.confirm`.
 *
 * Destructive actions used to pop a NATIVE dialog, so specs auto-accepted with
 * `page.on("dialog", d => d.accept())`. That handler is now dead code — Playwright only fires
 * `dialog` for browser-level dialogs, so a spec still relying on it would click the trigger, leave
 * our modal open, and then fail on a confusing "the row is still there" assertion rather than
 * anything that names the real cause.
 *
 * Centralised for the same reason as `workflow-picker.ts`: when the dialog's markup or copy changes,
 * this file is the single edit instead of every destructive-flow spec.
 */

/** The dialog root — `alertdialog`, deliberately not `dialog` (content modals own that role). */
export function confirmDialog(page: Page) {
  return page.getByRole("alertdialog");
}

/**
 * Confirm the pending action. Waits for the dialog first, so a spec fails with "alertdialog not
 * visible" (the action never opened one) rather than a downstream mystery.
 *
 * `label` asserts the accept button's text when a spec wants to pin the wording — the buttons name
 * the action ("Delete workflow"), never "OK", so this doubles as a check that the right question was
 * asked.
 */
export async function acceptConfirm(
  page: Page,
  label?: string | RegExp,
): Promise<void> {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  const accept = dialog.getByTestId("confirm-accept");
  if (label !== undefined) await expect(accept).toHaveText(label);
  await accept.click();
  // The dialog unmounts on decision; waiting here keeps a following assertion from racing it.
  await expect(dialog).toBeHidden();
}

/** Decline the pending action (the Cancel button). */
export async function dismissConfirm(page: Page): Promise<void> {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toBeHidden();
}
