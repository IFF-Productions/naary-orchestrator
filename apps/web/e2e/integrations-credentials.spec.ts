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

/**
 * Connection management — the "Connect a database" card (postgres/mssql) that
 * feeds the SQL Query node. UI gating only (no real DB / no mutation): the card
 * exposes engine/host/DSN fields, and the engine selector swaps the DSN hint.
 */
test.describe("integrations — database connections", () => {
  test("Connect a database card exposes engine/host/DSN; engine toggles the DSN hint", async ({
    page,
  }) => {
    await page.goto("/app/integrations");

    await expect(
      page.getByText("Connect a database", { exact: true }),
    ).toBeVisible();

    // Non-secret host + the secret DSN field (its placeholder is the postgres DSN).
    await expect(page.getByPlaceholder("localhost:5432")).toBeVisible();
    await expect(
      page.getByPlaceholder("postgres://user:pass@host:5432/db"),
    ).toBeVisible();

    // The engine selector is the only <select> offering both postgres and mssql.
    const engine = page.locator(
      'select:has(option[value="postgres"]):has(option[value="mssql"])',
    );
    await expect(engine).toBeVisible();

    // Switching to mssql swaps the DSN placeholder to the ADO connection-string form.
    await engine.selectOption("mssql");
    await expect(
      page.getByPlaceholder(/Server=host;Database=db/),
    ).toBeVisible();
  });
});
