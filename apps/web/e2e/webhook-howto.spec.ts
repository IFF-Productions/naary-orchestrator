import { expect, test } from "@playwright/test";

// After registering a webhook, the Integrations screen shows the one-time secret
// AND a ready-to-run signed curl (Slice: in-UI "how to trigger" docs).
test("registering a webhook shows a copy-run signed curl", async ({ page }) => {
  await page.goto("/app/integrations");

  // The webhook form lives in a Collapsible that's closed by default (its body is
  // not mounted until opened) — click the header to reveal the register form.
  await page.getByRole("button", { name: /Register a webhook/ }).click();

  // register against the seeded "default" workflow — CHOSEN from the dropdown of saved
  // workflows (no more typing a raw key). Scope to the select that has the "default" option
  // so we don't hit the provider dropdown.
  await page
    .locator("select", { has: page.locator('option[value="default"]') })
    .selectOption("default");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  // the how-to panel appears with the signature scheme + the curl command
  await expect(
    page.getByText("HMAC-SHA256 signature over the raw"),
  ).toBeVisible();
  await expect(page.getByText("Trigger it (copy & run)")).toBeVisible();
  const curl = page.locator("pre", { hasText: "X-Hub-Signature-256" });
  await expect(curl).toBeVisible();
  await expect(curl).toContainText("openssl dgst -sha256 -hmac");
  await expect(curl).toContainText("/hooks/");
  await expect(page.getByRole("button", { name: "Copy curl" })).toBeVisible();
});
