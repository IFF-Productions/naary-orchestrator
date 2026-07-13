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
    await page.goto("/app/integrations");

    await expect(
      page.getByText("Connect GitHub (App)", { exact: true }),
    ).toBeVisible();

    // The card is collapsed by default — expand it to reveal the form.
    await page.getByRole("button", { name: /Connect GitHub \(App\)/ }).click();

    // A label field (no token/PAT field — the app install itself is the credential)…
    await expect(page.getByPlaceholder("GitHub (prod)")).toBeVisible();
    // …and the redirect-to-github Install button.
    await expect(
      page.getByRole("button", { name: "Install GitHub App" }),
    ).toBeVisible();
  });
});
