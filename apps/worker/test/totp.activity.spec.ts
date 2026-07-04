import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import { __totpDeps, callTotp } from "../src/temporal/activities";

// RFC-6238 Appendix B test seed: ASCII "12345678901234567890" (SHA1) in base32.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

const resolveSigningKey = vi.fn();
const now = vi.fn();
beforeEach(() => {
  resolveSigningKey.mockReset();
  now.mockReset();
  __totpDeps.resolveSigningKey = resolveSigningKey as never;
  __totpDeps.now = now as never;
});

describe("callTotp", () => {
  it("matches the RFC-6238 vector (T=59, SHA1, 8 digits → 94287082)", async () => {
    resolveSigningKey.mockResolvedValue(SEED);
    now.mockReturnValue(59_000); // ms → 59s → counter 1
    const r = await callTotp(
      { connectionId: "sign-1", digits: 8 },
      undefined,
      meta,
    );
    expect(r).toEqual({ status: "ok", code: "94287082", costUsd: 0 });
    expect(resolveSigningKey).toHaveBeenCalledWith("t-1", "sign-1");
  });

  it("defaults to 6 digits (the last 6 of the RFC vector)", async () => {
    resolveSigningKey.mockResolvedValue(SEED);
    now.mockReturnValue(59_000);
    const r = await callTotp({ connectionId: "sign-1" }, undefined, meta);
    expect(r.code).toBe("287082");
  });

  it("a missing seed → non-retryable, and nothing secret leaks", async () => {
    resolveSigningKey.mockRejectedValue(
      new MissingConnectionTokenError("sign-1"),
    );
    now.mockReturnValue(59_000);
    const err = await callTotp(
      { connectionId: "sign-1" },
      undefined,
      meta,
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CONNECTION_REAUTH");
    expect(JSON.stringify(err)).not.toContain(SEED);
  });
});
