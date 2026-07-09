import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resume URLs for wait(webhook) nodes. The URL embeds an HMAC token over the run's workflowId, so
 * the URL itself IS the credential (like a signed webhook link) — anyone holding it may resume the
 * run, and it can't be forged without the server secret. Auth for the public resume endpoint is
 * this token, not a bearer.
 */

/** HMAC secret = the boot-required ENCRYPTION_KEY. The signed message is domain-separated with a
 *  "resume:" prefix so a token can never be replayed for another purpose that signs a bare id. */
function signingKey(): string {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) throw new Error("ENCRYPTION_KEY is required to sign resume URLs");
  return k;
}

/** Unforgeable per-run token = HMAC-SHA256(ENCRYPTION_KEY, "resume:"+workflowId), hex. */
export function mintResumeToken(workflowId: string): string {
  return createHmac("sha256", signingKey())
    .update(`resume:${workflowId}`)
    .digest("hex");
}

/** Constant-time token check. A non-hex / wrong-length token fails on the length guard. */
export function verifyResumeToken(
  workflowId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const expected = Buffer.from(mintResumeToken(workflowId), "hex");
  const given = Buffer.from(token, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Relative path an external system POSTs to resume the run — the host is prepended client-side,
 *  exactly like a webhook endpoint's `ingressPath`. */
export function resumePath(workflowId: string): string {
  return `/hooks/resume/${encodeURIComponent(workflowId)}?token=${mintResumeToken(workflowId)}`;
}
