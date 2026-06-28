import { expect, test } from "@playwright/test";

/**
 * Breadth smoke: each remaining screen loads (topbar title shows) and throws no
 * uncaught error. Catches a screen that white-screens on render.
 */
const SCREENS: [path: string, title: string][] = [
  ["/app/templates", "Templates"],
  ["/app/integrations", "Integrations"],
  ["/app/observability", "Observability"],
  ["/app/billing", "Billing & usage"],
  ["/app/team", "Team"],
  ["/app/settings", "Settings"],
];

for (const [path, title] of SCREENS) {
  test(`screen loads without error: ${title}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(path);
    await expect(page.getByRole("banner").getByText(title)).toBeVisible();

    expect(errors, `uncaught errors on ${path}`).toEqual([]);
  });
}
