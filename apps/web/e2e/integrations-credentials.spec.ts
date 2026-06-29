import { expect, test } from "@playwright/test";

/**
 * BYOK model-provider cards on the Integrations screen.
 *
 * No real provider key is needed: we assert the UI gating only — the supported
 * provider (Anthropic) exposes an "Add key" affordance with an inline form, and
 * unsupported providers (OpenAI/Google) render "Coming soon" instead. Proving an
 * agent run succeeds with a real key is BYOK and intentionally out of scope here.
 */
test.describe("integrations — model provider keys", () => {
  test("Anthropic offers an inline key form; others show Coming soon", async ({
    page,
  }) => {
    await page.goto("/app/integrations");

    await expect(
      page.getByText("Model providers", { exact: true }),
    ).toBeVisible();

    // Anthropic is the only supported provider → it owns the sole key button
    // ("Add key", or "Update key" if a row already exists).
    const keyButton = page.getByRole("button", { name: /Add key|Update key/ });
    await expect(keyButton).toBeVisible();

    // Unsupported providers (OpenAI/Google) are honestly gated.
    await expect(page.getByText("Coming soon").first()).toBeVisible();

    // Clicking the affordance opens an inline (password) key form.
    await keyButton.click();
    await expect(page.getByPlaceholder("Anthropic API key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();

    // Cancel collapses the form again.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByPlaceholder("Anthropic API key")).toHaveCount(0);
  });
});
