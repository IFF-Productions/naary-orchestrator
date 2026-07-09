import { expect, test } from "@playwright/test";

/**
 * Authenticated shell loads. global-setup put a `nry_` token in localStorage, so
 * the app renders the operator shell (not the sign-in screen).
 */
test("authenticated app shell renders", async ({ page }) => {
  await page.goto("/app");

  // Not bounced to the sign-in screen.
  await expect(page).toHaveURL(/\/app$/);

  // The shell chrome: nav links + the sign-out control. (The brand is a flame
  // Icon with no text, so we anchor on the nav + sign-out instead of brand text.)
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workflows" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("unauthenticated visit redirects to /auth", async ({ browser }) => {
  // A fresh context with NO storageState → no token → RequireAuth → /auth.
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/auth$/);
  await ctx.close();
});
