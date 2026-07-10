import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed approve/reject links for a paused humanApproval run (design: the notification-links gap).
 * Mirrors resume-token.ts: the URL embeds an HMAC token over the run's workflowId, so the URL IS the
 * credential — a recipient of the approval notification can decide WITHOUT a bearer/opening the app,
 * and it can't be forged without the server secret.
 *
 * IMPORTANT — the worker's notification activity mints the SAME token to build the link
 * (apps/worker/src/temporal/activities.ts, inside `approvalUrl()`). Both use ENCRYPTION_KEY over
 * "approval:"+workflowId; keep the two formulas identical or links won't verify.
 */
function signingKey(): string {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) throw new Error("ENCRYPTION_KEY is required to sign approval URLs");
  return k;
}

/** Unforgeable per-run token = HMAC-SHA256(ENCRYPTION_KEY, "approval:"+workflowId), hex. The token
 *  authorizes DECIDING the run (approve OR reject); the chosen decision travels in the request body,
 *  not the token, so one token backs both buttons on the decision page. */
export function mintApprovalToken(workflowId: string): string {
  return createHmac("sha256", signingKey())
    .update(`approval:${workflowId}`)
    .digest("hex");
}

/** Constant-time token check. A non-hex / wrong-length token fails on the length guard. */
export function verifyApprovalToken(
  workflowId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const expected = Buffer.from(mintApprovalToken(workflowId), "hex");
  const given = Buffer.from(token, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Relative path to the public decision page — the host is prepended client-side (like resumePath). */
export function approvalPath(workflowId: string): string {
  return `/approve/${encodeURIComponent(workflowId)}?token=${mintApprovalToken(workflowId)}`;
}
