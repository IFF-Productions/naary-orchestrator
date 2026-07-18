import { describe, expect, it } from "vitest";
import { envInt, workerIdentity, workerTuning } from "../src/worker-tuning";

describe("workerIdentity", () => {
  it("is host/pid/version shaped and stable within a process", () => {
    const id = workerIdentity();
    expect(id).toMatch(/^.+\/\d+\/.+$/); // <host>/<pid>/<version>
    expect(id).toBe(workerIdentity());
    expect(id.split("/")[1]).toBe(String(process.pid));
  });
});

describe("envInt", () => {
  it("parses a positive integer, else undefined", () => {
    expect(envInt("X", { X: "8" })).toBe(8);
    expect(envInt("X", {})).toBeUndefined();
    expect(envInt("X", { X: "" })).toBeUndefined();
    expect(envInt("X", { X: "0" })).toBeUndefined(); // not positive
    expect(envInt("X", { X: "-4" })).toBeUndefined();
    expect(envInt("X", { X: "1.5" })).toBeUndefined(); // not integer
    expect(envInt("X", { X: "abc" })).toBeUndefined();
  });
});

describe("workerTuning", () => {
  it("is empty when no knobs are set (SDK defaults preserved — no undefined overrides)", () => {
    expect(workerTuning({})).toEqual({});
  });

  it("maps each env knob to its Worker.create option", () => {
    expect(
      workerTuning({
        WORKER_MAX_ACTIVITIES: "20",
        WORKER_MAX_WORKFLOW_TASKS: "10",
        WORKER_MAX_CACHED_WORKFLOWS: "200",
        WORKER_SHUTDOWN_GRACE: "30s",
      }),
    ).toEqual({
      maxConcurrentActivityTaskExecutions: 20,
      maxConcurrentWorkflowTaskExecutions: 10,
      maxCachedWorkflows: 200,
      shutdownGraceTime: "30s",
    });
  });

  it("omits invalid/blank knobs (a typo can't disable a default with undefined)", () => {
    expect(
      workerTuning({
        WORKER_MAX_ACTIVITIES: "oops",
        WORKER_SHUTDOWN_GRACE: " ",
      }),
    ).toEqual({});
  });
});
