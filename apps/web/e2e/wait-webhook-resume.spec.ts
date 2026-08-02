import { expect, test } from "@playwright/test";

/**
 * The durable human-in-the-loop differentiator (PR #192): a wait node in `webhook`
 * mode pauses the run *indefinitely* (status `awaiting_webhook`) until an external
 * system POSTs to the run's signed resume URL — then the run continues to
 * completion. This exercises the full loop through the REAL Temporal interpreter:
 *   run → park in awaiting_webhook → POST the signed resume URL → complete.
 *
 * The "e2e-wait-webhook" workflow (start → wait(webhook) → end) is seeded by
 * global-setup. The resume endpoint is public — the signed token in the URL's query
 * IS the auth — so we POST it with no bearer header, exactly as a caller would.
 */
test("wait(webhook): a run pauses, then its signed resume URL completes it", async ({
  page,
}) => {
  await page.goto("/app/workflows/e2e-wait-webhook");
  await page.getByRole("button", { name: "Run now" }).click();

  // Lands on the run detail and parks in the awaiting-webhook state.
  await expect(page).toHaveURL(/\/app\/runs\/.+/);
  await expect(page.getByText("Waiting for a webhook")).toBeVisible({
    timeout: 20_000,
  });

  // The signed resume URL renders (…/api/hooks/resume/<workflowId>?token=…).
  const urlCode = page.locator("code.mono", { hasText: "/hooks/resume/" });
  await expect(urlCode).toBeVisible();
  const resumeUrl = (await urlCode.textContent())?.trim();
  expect(resumeUrl).toMatch(/\/hooks\/resume\/.+token=/);

  // POST to it with NO auth header — the query token is the credential. 202 Accepted.
  const res = await page.request.post(resumeUrl!, {
    headers: { "content-type": "application/json" },
    data: {},
  });
  expect(res.status()).toBe(202);

  // The interpreter resumes past the wait node and the run finishes.
  //
  // NOT `getByText("Completed")`, which is what this line used to say. Playwright treats a plain
  // string as a CASE-INSENSITIVE SUBSTRING, and the Execution log renders a `"Activity completed"`
  // row per activity (`apps/api/src/executions/executions.helpers.ts:177`) — including the
  // start-up activities that run before the interpreter ever reaches the wait node. So the old
  // assertion was already satisfied back at line 22, before the POST above had happened.
  //
  // Measured: delete the POST entirely — the run then parks in `awaiting_webhook` forever — and
  // the old assertion still passed, in 3.3s. The signed-resume path could be wholly broken and
  // this spec, the only guard on the product's stated differentiator, stayed green.
  //
  // `"Run completed"` is emitted only by the terminal hero (`run-detail/StatusHero.tsx`) and the
  // terminal log event, both of which require the run to have actually finished.
  await expect(
    page.getByText("Run completed", { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 });
  // ...and the park state was LEFT, not merely joined by a later row. This is the half that says
  // "resumed" rather than "reached some terminal state".
  await expect(page.getByText("Waiting for a webhook")).toHaveCount(0);
});
