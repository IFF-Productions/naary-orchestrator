import { describe, expect, it } from "vitest";
import { TASK_QUEUE, TASK_QUEUE_HEAVY } from "@naary/contracts";
import { workerVersion } from "../src/config";
import {
  envInt,
  resolveTaskQueue,
  workerIdentity,
  workerTuning,
} from "../src/worker-tuning";

describe("resolveTaskQueue (Queue-mode §3.3)", () => {
  it("defaults to the interactive queue when unset", () => {
    expect(resolveTaskQueue({})).toBe(TASK_QUEUE);
    expect(resolveTaskQueue({ WORKER_TASK_QUEUE: "" })).toBe(TASK_QUEUE);
    expect(resolveTaskQueue({ WORKER_TASK_QUEUE: "   " })).toBe(TASK_QUEUE);
  });
  it("honors WORKER_TASK_QUEUE for a heavy worker", () => {
    expect(resolveTaskQueue({ WORKER_TASK_QUEUE: TASK_QUEUE_HEAVY })).toBe(
      TASK_QUEUE_HEAVY,
    );
    expect(resolveTaskQueue({ WORKER_TASK_QUEUE: "  custom-q " })).toBe(
      "custom-q",
    );
  });
});

describe("workerIdentity", () => {
  it("is host/pid/version shaped and stable within a process", () => {
    const id = workerIdentity();
    expect(id).toMatch(/^.+\/\d+\/.+$/); // <host>/<pid>/<version>
    expect(id).toBe(workerIdentity());
    expect(id.split("/")[1]).toBe(String(process.pid));
  });

  /**
   * The version segment must be the VERSION, not a stringified accessor. When the version stopped
   * being a module-level const (an import-time env read races dotenv) the interpolation kept
   * compiling and the shape assertion above kept passing — `() => workerVersion()` contains no
   * slash — while every Temporal poller and every fleet row got a function body as its identity.
   */
  it("interpolates the version value, never the accessor itself", () => {
    const version = workerIdentity().split("/").slice(2).join("/");
    expect(version).toBe(workerVersion());
    expect(version).not.toMatch(/=>|function/);
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
