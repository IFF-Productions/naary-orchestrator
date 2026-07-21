import { expect, test } from "@playwright/test";

/**
 * GitHub App connect card on the Integrations screen.
 *
 * UI gating only (no real GitHub App / no navigation off-site): the card is a
 * collapsible that, once expanded, exposes a label field and an "Install GitHub
 * App" button. Clicking it would full-page-navigate to github.com (the API's
 * install/start returns that URL), so we assert the affordances are present but
 * do NOT click Install — the live install handshake is out of scope here.
 */
test.describe("integrations — GitHub App connect", () => {
  test("GitHub App card expands to a label field + Install button", async ({
    page,
  }) => {
    // GitHub App lives on the "Apps & agents" tab now.
    await page.goto("/app/integrations?tab=apps");

    // "Install GitHub App" opens a dialog with the connect form (the tab button is the only
    // such button until the dialog mounts the form's submit).
    await page
      .getByRole("button", { name: "Install GitHub App" })
      .first()
      .click();

    // A label field (no token/PAT field — the app install itself is the credential)…
    await expect(page.getByPlaceholder("GitHub (prod)")).toBeVisible();
    // …and the redirect-to-github Install button inside the dialog form.
    await expect(
      page.getByRole("button", { name: "Install GitHub App" }).last(),
    ).toBeVisible();
  });
});
