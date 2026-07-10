import { expect, test } from "@playwright/test";

/**
 * Chat Trigger program — the hosted public chat, end-to-end through the real UI:
 *   register a chat in Integrations (against the seeded `e2e-chat` chatTrigger graph) → the
 *   shareable /c/:id URL is minted → open it as an ANONYMOUS page → send a message → see the reply.
 *
 * The `e2e-chat` graph (chatTrigger → respondToWebhook echoing the message → end) is hermetic (no
 * LLM). global-setup also seeds the tenant budget cap that chat registration requires.
 */
test("hosted chat: register in Integrations, then message the public page anonymously", async ({
  page,
  browser,
}) => {
  // ---- register the chat (AUTHENTICATED app) ----
  await page.goto("/app/integrations");
  await page.getByRole("button", { name: /Register a chat/ }).click();
  await page.getByPlaceholder("support-chat").fill("e2e-chat");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  const urlSpan = page.locator("span.mono", { hasText: "/c/" }).first();
  await expect(urlSpan).toBeVisible({ timeout: 15_000 });
  const minted = (await urlSpan.textContent())?.trim() ?? "";
  const chatPath = minted.match(/\/c\/[\w-]+/)?.[0];
  expect(chatPath, `minted a /c/ URL (got: ${minted})`).toBeTruthy();

  // ---- open the chat in a FRESH ANONYMOUS context (the real audience) ----
  const anon = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const visitor = await anon.newPage();
    await visitor.goto(chatPath!);
    await expect(visitor.getByText("E2E Chat")).toBeVisible({
      timeout: 15_000,
    });
    // the greeting renders as the first assistant turn
    await expect(visitor.getByText("Hi there!")).toBeVisible();

    // ---- send a message; the graph echoes it back as the reply ----
    await visitor
      .getByPlaceholder(/Type a message/)
      .fill("hello from the e2e chat");
    await visitor.getByRole("button", { name: "Send" }).click();

    // user turn + the echoed assistant reply both appear
    await expect(visitor.getByText("hello from the e2e chat")).toHaveCount(2, {
      timeout: 20_000,
    });
  } finally {
    await anon.close();
  }
});
