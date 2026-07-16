import { beforeAll, describe, expect, it } from "vitest";

// The token secret is ENCRYPTION_KEY; set it before importing the module under test.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

describe("resume token", () => {
  it("round-trips: a minted token verifies for its own workflowId", async () => {
    const { mintResumeToken, verifyResumeToken } =
      await import("../src/executions/resume-token.js");
    const token = mintResumeToken("run-123");
    expect(verifyResumeToken("run-123", token)).toBe(true);
  });

  it("rejects a token minted for a DIFFERENT run (per-run binding)", async () => {
    const { mintResumeToken, verifyResumeToken } =
      await import("../src/executions/resume-token.js");
    const token = mintResumeToken("run-123");
    expect(verifyResumeToken("run-999", token)).toBe(false);
  });

  it("rejects a forged / malformed / empty token", async () => {
    const { verifyResumeToken } =
      await import("../src/executions/resume-token.js");
    expect(verifyResumeToken("run-123", "deadbeef")).toBe(false);
    expect(verifyResumeToken("run-123", "not-hex-zzz")).toBe(false);
    expect(verifyResumeToken("run-123", "")).toBe(false);
    expect(verifyResumeToken("run-123", undefined)).toBe(false);
  });

  it("builds a resume path embedding the workflowId + token", async () => {
    const { resumePath, mintResumeToken } =
      await import("../src/executions/resume-token.js");
    const path = resumePath("run-123");
    expect(path).toBe(
      `/hooks/resume/run-123?token=${mintResumeToken("run-123")}`,
    );
  });
});
