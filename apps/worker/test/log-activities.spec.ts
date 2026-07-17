import { describe, expect, it, vi } from "vitest";
import { logActivities } from "../src/temporal/log-activities";

/**
 * logActivities emits ONE completion line per activity invocation, carrying the run's
 * correlation ids + duration + ok/fail. These assert the observable contract: behavior is
 * preserved (values/errors pass through) and the log record is id-only + carries a SAFE error
 * class, never the message/stack (CLAUDE.md Tier-1 §4).
 */

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

const META = { tenantId: "t1", executionId: "x1", nodeId: "n1" };

describe("logActivities", () => {
  it("passes non-function entries through by reference (Temporal dispatch, __httpDeps)", () => {
    const deps = { fetch: "not-a-fn" };
    const wrapped = logActivities({ __httpDeps: deps }, makeLog());
    expect(wrapped.__httpDeps).toBe(deps);
  });

  it("returns the activity's value unchanged and logs an ok completion with ids", async () => {
    const log = makeLog();
    const wrapped = logActivities(
      {
        callHttpRequest: async (_cfg: unknown, _meta: unknown) => ({ ok: 200 }),
      },
      log,
    );

    const out = await wrapped.callHttpRequest({ url: "https://x" }, META);
    expect(out).toEqual({ ok: 200 });

    expect(log.info).toHaveBeenCalledTimes(1);
    const [record, msg] = log.info.mock.calls[0];
    expect(msg).toBe("activity completed");
    expect(record).toMatchObject({
      activity: "callHttpRequest",
      tenantId: "t1",
      executionId: "x1",
      nodeId: "n1",
      ok: true,
    });
    expect(typeof record.durationMs).toBe("number");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    // No secret-shaped fields leaked from the config arg.
    expect(record).not.toHaveProperty("url");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rethrows the IDENTICAL error and logs a failure with the error class only", async () => {
    const log = makeLog();
    const boom = new TypeError("secret-token=abc leaked in message");
    const wrapped = logActivities(
      {
        callAgent: async (_meta: unknown) => {
          throw boom;
        },
      },
      log,
    );

    await expect(wrapped.callAgent(META)).rejects.toBe(boom);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [record, msg] = log.warn.mock.calls[0];
    expect(msg).toBe("activity failed");
    expect(record).toMatchObject({
      activity: "callAgent",
      tenantId: "t1",
      ok: false,
      errorName: "TypeError",
    });
    // The SAFE classifier only — never the message/stack.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("leaked");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("handles a synchronous throw the same way (rethrow + failure log)", () => {
    const log = makeLog();
    const err = new Error("sync boom");
    const wrapped = logActivities(
      {
        syncActivity: (_meta: unknown) => {
          throw err;
        },
      },
      log,
    );
    expect(() => wrapped.syncActivity(META)).toThrow(err);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      ok: false,
      errorName: "Error",
    });
  });

  it("treats a foreign thenable as async (logs on settle, not immediately)", async () => {
    const log = makeLog();
    // A thenable that is NOT a native Promise — `instanceof Promise` would miss it.
    const thenable = {
      then(onOk: (v: unknown) => void) {
        onOk({ done: true });
      },
    };
    const wrapped = logActivities(
      { thenableActivity: (_meta: unknown) => thenable },
      log,
    );

    const out = await wrapped.thenableActivity(META);
    expect(out).toEqual({ done: true });
    // Logged once, on resolution — with ids, as a success.
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatchObject({
      activity: "thenableActivity",
      tenantId: "t1",
      ok: true,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
