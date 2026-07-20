import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalPath,
  mintApprovalToken,
  verifyApprovalToken,
} from "../src/executions/approval-token";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

describe("approval-token", () => {
  it("round-trips: a minted token verifies for its workflowId", () => {
    const t = mintApprovalToken("wf-1");
    expect(verifyApprovalToken("wf-1", t)).toBe(true);
  });

  it("rejects a token for a DIFFERENT workflowId (can't be replayed)", () => {
    const t = mintApprovalToken("wf-1");
    expect(verifyApprovalToken("wf-2", t)).toBe(false);
  });

  it("rejects a missing / tampered / wrong-length token", () => {
    expect(verifyApprovalToken("wf-1", undefined)).toBe(false);
    expect(verifyApprovalToken("wf-1", "deadbeef")).toBe(false);
    const t = mintApprovalToken("wf-1");
    expect(verifyApprovalToken("wf-1", `${t}00`)).toBe(false);
  });

  it("is domain-separated from resume tokens (different prefix)", async () => {
    const { mintResumeToken } =
      await import("../src/executions/resume-token.js");
    expect(mintApprovalToken("wf-1")).not.toBe(mintResumeToken("wf-1"));
  });

  it("approvalPath embeds the workflowId + a verifying token WITH an expiry claim", () => {
    const p = approvalPath("wf-1");
    expect(p).toMatch(/^\/approve\/wf-1\?token=[0-9a-f]{64}&exp=\d+$/);
    const url = new URL(`https://x.test${p}`);
    const token = url.searchParams.get("token") ?? undefined;
    const exp = url.searchParams.get("exp") ?? undefined;
    expect(verifyApprovalToken("wf-1", token, exp)).toBe(true);
    // The exp claim is in the FUTURE (freshly minted).
    expect(Number(exp)).toBeGreaterThan(Date.now() / 1000);
  });

  // --- Expiring links (Slice 1) ---

  it("round-trips an expiring token (exp signed into the claim)", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = mintApprovalToken("wf-1", exp);
    expect(verifyApprovalToken("wf-1", t, exp)).toBe(true);
    expect(verifyApprovalToken("wf-1", t, String(exp))).toBe(true);
  });

  it("rejects an ELAPSED expiry claim", () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const t = mintApprovalToken("wf-1", exp);
    expect(verifyApprovalToken("wf-1", t, exp)).toBe(false);
  });

  it("rejects a TAMPERED exp (claim is signed — extending the window fails HMAC)", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = mintApprovalToken("wf-1", exp);
    expect(verifyApprovalToken("wf-1", t, exp + 999_999)).toBe(false);
    // Dropping the claim entirely falls back to the legacy formula — also fails.
    expect(verifyApprovalToken("wf-1", t)).toBe(false);
    expect(verifyApprovalToken("wf-1", t, "not-a-number")).toBe(false);
  });

  it("legacy exp-less tokens still verify (old links keep working, expiresAt null)", () => {
    const t = mintApprovalToken("wf-1");
    expect(verifyApprovalToken("wf-1", t)).toBe(true);
    expect(verifyApprovalToken("wf-1", t, "")).toBe(true); // empty exp param = legacy
  });
});
