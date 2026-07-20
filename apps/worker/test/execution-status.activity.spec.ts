/**
 * Slice 2 (per-node timing + cost) unit coverage for the read-model terminal push:
 *  - setExecutionStatus stamps finishedAt ONLY on terminal statuses (clock read
 *    in-activity, Tier-1 rule 2) and persists failureKind — explicit for thrown
 *    failures, derived from the status for returned terminals (rejected/budget).
 *  - classifyFailure maps the failure the workflow actually observed to the
 *    compact kind (pure + deterministic — safe in workflow code).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Failure classes come via @temporalio/workflow's re-export (same classes the
// interpreter's instanceof checks see; @temporalio/common isn't a direct dep here).
import { ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";

type TimeoutTypeArg = ConstructorParameters<typeof TimeoutFailure>[2];
/** classifyFailure only checks `instanceof TimeoutFailure` — the enum value is inert. */
const START_TO_CLOSE = 2 as unknown as TimeoutTypeArg;

// Hermetic: mock @naary/db so no live Postgres is needed (pattern of
// poll-cursor.spec.ts). setExecutionStatus best-effort-updates one row.
const update = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { update } }),
  getDefaultEnvironmentId: async () => "env-default",
}));

import { setExecutionStatus } from "../src/temporal/activities/execution";
import { classifyFailure } from "../src/temporal/workflow/helpers";

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue({});
});

describe("setExecutionStatus (Slice 2 terminal stamps)", () => {
  it("a NON-terminal push updates status only — no finishedAt, no failureKind", async () => {
    await setExecutionStatus({ workflowId: "w1", status: "running" });
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("running");
    expect(data.finishedAt).toBeUndefined();
    expect(data.failureKind).toBeUndefined();
  });

  it("a terminal 'completed' push stamps finishedAt (in-activity clock) without a failureKind", async () => {
    const before = Date.now();
    await setExecutionStatus({
      workflowId: "w1",
      status: "completed",
      costUsd: 0.1,
    });
    const data = update.mock.calls[0][0].data;
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect((data.finishedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(data.failureKind).toBeUndefined();
  });

  it("derives failureKind from RETURNED terminal statuses: rejected → rejected, budget_exceeded → budget", async () => {
    await setExecutionStatus({ workflowId: "w1", status: "rejected" });
    expect(update.mock.calls[0][0].data.failureKind).toBe("rejected");
    await setExecutionStatus({ workflowId: "w1", status: "budget_exceeded" });
    expect(update.mock.calls[1][0].data.failureKind).toBe("budget");
    // circuit_open/invalid_graph: the status is already the most precise label.
    await setExecutionStatus({ workflowId: "w1", status: "circuit_open" });
    expect(update.mock.calls[2][0].data.failureKind).toBeUndefined();
    expect(update.mock.calls[2][0].data.finishedAt).toBeInstanceOf(Date);
  });

  it("an EXPLICIT (workflow-classified) failureKind wins for thrown failures", async () => {
    await setExecutionStatus({
      workflowId: "w1",
      status: "failed",
      failureKind: "rate_limit",
    });
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("failed");
    expect(data.failureKind).toBe("rate_limit");
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it("stays best-effort: a missing row never throws", async () => {
    update.mockRejectedValueOnce(new Error("row not found"));
    await expect(
      setExecutionStatus({ workflowId: "gone", status: "failed" }),
    ).resolves.toBeUndefined();
  });
});

describe("classifyFailure (pure, deterministic)", () => {
  const app = (message: string, type: string) =>
    ApplicationFailure.create({ message, type, nonRetryable: true });
  /** Wrap like Temporal does: ActivityFailure(cause: ApplicationFailure). A plain
   *  Error with a cause is enough — classifyFailure walks the `cause` chain. */
  const wrapped = (cause: unknown) => {
    const e = new Error("Activity task failed");
    (e as { cause?: unknown }).cause = cause;
    return e;
  };

  it("QUOTA (provider 429) → rate_limit, even wrapped in an activity failure", () => {
    expect(classifyFailure(app("429 from provider", "QUOTA"))).toBe(
      "rate_limit",
    );
    expect(classifyFailure(wrapped(app("429", "QUOTA")))).toBe("rate_limit");
  });

  it("BUDGET → budget", () => {
    expect(classifyFailure(app("Monthly budget exceeded", "BUDGET"))).toBe(
      "budget",
    );
  });

  it("TimeoutFailure / *_TIMEOUT types → timeout", () => {
    expect(
      classifyFailure(
        wrapped(
          new TimeoutFailure("activity timed out", undefined, START_TO_CLOSE),
        ),
      ),
    ).toBe("timeout");
    expect(classifyFailure(app("code ran too long", "CODE_TIMEOUT"))).toBe(
      "timeout",
    );
  });

  it("HTTP_ERROR_STATUS: 5xx → upstream_5xx; 4xx stays error (caller's config)", () => {
    expect(
      classifyFailure(
        app("HTTP request returned status 503", "HTTP_ERROR_STATUS"),
      ),
    ).toBe("upstream_5xx");
    expect(
      classifyFailure(
        app("HTTP request returned status 404", "HTTP_ERROR_STATUS"),
      ),
    ).toBe("error");
  });

  it("everything else (STOP_AND_ERROR, AUTH, unknown throwables) → error", () => {
    expect(classifyFailure(app("stopped", "STOP_AND_ERROR"))).toBe("error");
    expect(classifyFailure(app("bad key", "AUTH"))).toBe("error");
    expect(classifyFailure(new Error("boom"))).toBe("error");
    expect(classifyFailure("string throw")).toBe("error");
  });
});
