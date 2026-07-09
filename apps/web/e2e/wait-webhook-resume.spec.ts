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
  await expect(page.getByText("Completed").first()).toBeVisible({
    timeout: 20_000,
  });
});
