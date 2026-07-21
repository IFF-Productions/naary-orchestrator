import { expect, test } from "@playwright/test";

/**
 * BYOK model-provider cards on the Integrations screen (redesigned: cards → a key DIALOG).
 *
 * No real provider key is needed: we assert the UI only — each model provider (Anthropic /
 * OpenAI / Google) exposes an "Add key" affordance that opens a key dialog with a
 * provider-named password field + Save. Proving an agent run succeeds with a real key is
 * BYOK and intentionally out of scope here.
 */
test.describe("integrations — model provider keys", () => {
  test("a model provider opens a key dialog with a password field", async ({
    page,
  }) => {
    await page.goto("/app/integrations");

    // Providers (BYOK) is the default tab.
    await expect(
      page.getByRole("tab", { name: "Providers (BYOK)" }),
    ).toBeVisible();

    // Each model provider exposes an "Add key" affordance; open the first (Anthropic).
    const keyButton = page
      .getByRole("button", { name: /Add key|Update key/ })
      .first();
    await expect(keyButton).toBeVisible();

    // Clicking it opens a key dialog with the provider-named (password) field + Save.
    await keyButton.click();
    await expect(page.getByPlaceholder("Anthropic API key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();

    // Cancel closes the dialog.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByPlaceholder("Anthropic API key")).toHaveCount(0);
  });
});

/**
 * Connection management — the "SQL databases" card opens a "Connect a database" dialog
 * (postgres/mysql/mssql) that feeds the SQL Query node. UI only (no real DB / no mutation):
 * the dialog exposes engine/host/DSN fields, and the engine selector swaps the DSN hint.
 */
test.describe("integrations — database connections", () => {
  test("the SQL databases card opens a dialog with engine/host/DSN; engine toggles the DSN hint", async ({
    page,
  }) => {
    await page.goto("/app/integrations");

    await expect(page.getByText("SQL databases")).toBeVisible();

    // Open the SQL databases connection dialog (the first "Add connection" group).
    await page.getByRole("button", { name: "Add connection" }).first().click();
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
