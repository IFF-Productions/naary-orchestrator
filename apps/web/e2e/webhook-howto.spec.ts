import { expect, test } from "@playwright/test";
import { pickWorkflow } from "./workflow-picker";

// After registering a webhook, the Integrations screen shows the one-time secret
// AND a ready-to-run signed curl (Slice: in-UI "how to trigger" docs).
test("registering a webhook shows a copy-run signed curl", async ({ page }) => {
  await page.goto("/app/integrations?tab=webhooks");

  // The registration form lives in a dialog now — "New webhook" opens it ("Register a webhook").
  await page.getByRole("button", { name: "New webhook" }).click();

  // register against the seeded "default" workflow — CHOSEN from the picker of saved workflows
  // (no more typing a raw key). The picker is a filterable combobox, so this also can't collide
  // with the provider dropdown the way a bare `select` locator could.
  await pickWorkflow(page, "default");
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
