import { expect, test } from "@playwright/test";

// After registering a webhook, the Integrations screen shows the one-time secret
// AND a ready-to-run signed curl (Slice: in-UI "how to trigger" docs).
test("registering a webhook shows a copy-run signed curl", async ({ page }) => {
  await page.goto("/app/integrations");
  await expect(page.getByText("Register a webhook")).toBeVisible();

  // register against the seeded "default" workflow (generic provider)
  await page.getByPlaceholder("wf-default").fill("default");
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
