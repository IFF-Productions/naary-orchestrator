import { createHmac, timingSafeEqual } from "node:crypto";
import { encryptionKey } from "../config";

/**
 * Signed approve/reject links for a paused humanApproval run (design: the notification-links gap).
 * Mirrors resume-token.ts: the URL embeds an HMAC token over the run's workflowId, so the URL IS the
 * credential — a recipient of the approval notification can decide WITHOUT a bearer/opening the app,
 * and it can't be forged without the server secret.
 *
 * IMPORTANT — the worker's notification activity mints the SAME token to build the link
 * (apps/worker/src/temporal/activities/notifications.ts, inside `approvalUrl()`). Both use
 * ENCRYPTION_KEY; keep the two formulas identical or links won't verify.
 *
 * EXPIRY (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1): newly minted links carry a unix-seconds
 * expiry claim SIGNED INTO the token (`approval:<id>:<exp>`) and exposed as `exp=` in the URL.
 * Legacy links (minted before the claim existed) have no `exp` and verify with the old
 * `approval:<id>` formula — they never expire (can't retrofit a claim into an already-sent
 * link) and surface `expiresAt: null`.
 */
function signingKey(): string {
  const k = encryptionKey();
  if (!k) throw new Error("ENCRYPTION_KEY is required to sign approval URLs");
  return k;
}

/** How long a newly minted approval link stays valid (matches the worker's constant). */
export const APPROVAL_LINK_TTL_SECONDS = 7 * 24 * 3600;

/** Unforgeable per-run token = HMAC-SHA256(ENCRYPTION_KEY, "approval:"+workflowId[+":"+exp]),
 *  hex. The token authorizes DECIDING the run (approve OR reject); the chosen decision travels
 *  in the request body, not the token, so one token backs both buttons on the decision page.
 *  Pass `exp` (unix seconds) to mint an expiring token; omit for the legacy formula. */
export function mintApprovalToken(workflowId: string, exp?: number): string {
  const claim =
    exp === undefined
      ? `approval:${workflowId}`
      : `approval:${workflowId}:${exp}`;
  return createHmac("sha256", signingKey()).update(claim).digest("hex");
}

/** Constant-time token check. A non-hex / wrong-length token fails on the length guard.
 *  When `exp` is provided (the link carried an expiry claim) the claim is part of the signed
 *  payload — a tampered `exp` fails the HMAC — and an elapsed expiry fails outright. Without
 *  `exp`, the legacy exp-less formula is checked (old links keep working). */
export function verifyApprovalToken(
  workflowId: string,
  token: string | undefined,
  exp?: string | number,
): boolean {
  if (!token) return false;
  let expected: Buffer;
  if (exp !== undefined && exp !== "") {
    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) return false;
    if (expNum * 1000 < Date.now()) return false; // expired claim
    expected = Buffer.from(mintApprovalToken(workflowId, expNum), "hex");
  } else {
    expected = Buffer.from(mintApprovalToken(workflowId), "hex");
  }
  const given = Buffer.from(token, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Relative path to the public decision page — the host is prepended client-side (like
 *  resumePath). Newly minted paths carry the expiry claim. */
export function approvalPath(workflowId: string): string {
  const exp = Math.floor(Date.now() / 1000) + APPROVAL_LINK_TTL_SECONDS;
  return `/approve/${encodeURIComponent(workflowId)}?token=${mintApprovalToken(workflowId, exp)}&exp=${exp}`;
}
