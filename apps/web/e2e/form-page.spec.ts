import { expect, test } from "@playwright/test";

/**
 * Form Trigger mini-program, slice 3 — the hosted public form, end-to-end through the real UI:
 *   register a form in Integrations (against the seeded `e2e-form` formTrigger graph) → the
 *   shareable /f/:id URL is minted → open it as an anonymous page → fill + submit → completion.
 *
 * global-setup seeds both prerequisites: a monthly budget cap on the tenant (required before a
 * public form can be registered) and the `e2e-form` graph whose entry node is a formTrigger.
 */
test("hosted form: register in Integrations, then submit the public page anonymously", async ({
  page,
  browser,
}) => {
  // ---- register the form (AUTHENTICATED app) ----
  await page.goto("/app/integrations");
  await page.getByRole("button", { name: /Register a form/ }).click();
  await page.getByPlaceholder("contact-form").fill("e2e-form");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  // The minted public URL appears (…/f/<formId>). Pull the path out of it.
  const urlSpan = page.locator("span.mono", { hasText: "/f/" }).first();
  await expect(urlSpan).toBeVisible({ timeout: 15_000 });
  const minted = (await urlSpan.textContent())?.trim() ?? "";
  const formPath = minted.match(/\/f\/[\w-]+/)?.[0];
  expect(formPath, `minted a /f/ URL (got: ${minted})`).toBeTruthy();

  // ---- open the form in a FRESH ANONYMOUS context (empty storage) — this is the real audience:
  //      a visitor with NO session. The authed `page` above would mask a broken anonymous path. ----
  const anon = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const visitor = await anon.newPage();
    await visitor.goto(formPath!);
    await expect(visitor.getByText("E2E Contact")).toBeVisible({
      timeout: 15_000,
    });
    await expect(visitor.getByText("Say hello.")).toBeVisible();

    // ---- fill + submit ----
    await visitor.getByLabel("Email").fill("visitor@example.com");
    await visitor.getByLabel("Message").fill("Hi from the e2e form.");
    await visitor.getByRole("button", { name: "Send it" }).click();

    // ---- completion screen ----
    await expect(visitor.getByText("Thanks — we've got it.")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await anon.close();
  }
});
