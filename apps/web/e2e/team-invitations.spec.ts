import { expect, test } from "@playwright/test";

/**
 * Provisioning slice 2/3 flows, driven as the workspace OWNER (the e2e `nry_` token
 * resolves to role "owner"):
 *  - the workspace switcher renders the active workspace in the sidebar;
 *  - the Team screen lets an admin/owner invite by email, surfaces the one-time invite
 *    link, lists it as pending, and revokes it.
 *
 * The accept flow and role-negative gating (member → 403) need a Firebase member identity
 * the token-only harness can't mint, so they're covered by API unit tests, not here.
 */

test("workspace switcher shows the active workspace in the sidebar", async ({
  page,
}) => {
  await page.goto("/app");
  // The switcher button (brand + workspace + chevron); its accessible name is its text,
  // so target the `title` tooltip instead.
  const switcher = page.getByTitle("Switch workspace");
  await expect(switcher).toBeVisible();
  // The e2e token's tenant is t-demo; legacy `t-*` ids render verbatim.
  await expect(switcher).toContainText("t-demo");
  // Opening it lists the workspace as an option.
  await switcher.click();
  await expect(page.getByRole("option", { name: /t-demo/ })).toBeVisible();
});

test("owner can invite a teammate, see the one-time link, and revoke it", async ({
  page,
}) => {
  // Unique per run so repeated runs don't collide in the pending list.
  const email = `e2e-invite-${Date.now()}@example.com`;

  await page.goto("/app/team");

  // The invite form (admin+ only) being present is the signal the Team screen loaded
  // for the owner token.
  const emailInput = page.getByPlaceholder("teammate@company.com");
  await expect(emailInput).toBeVisible();
  await emailInput.fill(email);

  await page.getByRole("button", { name: "Invite" }).click();

  // The raw invite token is shown exactly once as a shareable /invite/<token> link.
  await expect(page.getByText(/won't be shown again/i)).toBeVisible();
  await expect(page.getByText(/\/invite\//)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();

  // It appears in the pending-invites list.
  await expect(page.getByText("Pending invites")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  // Revoke the row for THIS email (scoped so leftover invites from prior runs are untouched).
  const inviteRow = page
    .locator("div")
    .filter({ hasText: email })
    .filter({ has: page.getByRole("button", { name: "Revoke invite" }) })
    .last();
  await inviteRow.getByRole("button", { name: "Revoke invite" }).click();

  await expect(page.getByText(email)).toHaveCount(0);
});
