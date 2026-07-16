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
    const { mintResumeToken } = await import("../src/executions/resume-token.js");
    expect(mintApprovalToken("wf-1")).not.toBe(mintResumeToken("wf-1"));
  });

  it("approvalPath embeds the workflowId + a verifying token", () => {
    const p = approvalPath("wf-1");
    expect(p).toMatch(/^\/approve\/wf-1\?token=[0-9a-f]{64}$/);
    const token = p.split("token=")[1];
    expect(verifyApprovalToken("wf-1", token)).toBe(true);
  });
});
