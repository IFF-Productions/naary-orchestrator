/**
 * Guard for the #1073 flake matcher.
 *
 * `makeWorker` retries exactly one failure — the Rust core refusing a second worker on a task
 * queue its predecessor still holds — and throws everything else on the first attempt. That makes
 * the REGEX the whole safety property: too narrow and the flake comes back with a retry sitting
 * uselessly beside it; too broad and a genuine misconfiguration gets retried three times before
 * anyone is told.
 *
 * The positive case is the VERBATIM message from the failing CI job
 * (worker-e2e shard 2, run 30766657482) — not a paraphrase, because a matcher tested only against
 * its author's idea of the message is a matcher that has never met the error.
 */
import { describe, expect, it } from "vitest";
import { WORKER_REGISTRATION_OVERLAP_RE } from "./interpreter-harness";

const REAL_CI_ERROR =
  "Failed to initialize worker: Registration of multiple workers with overlapping worker task " +
  "types on the same namespace, task queue, and deployment build ID not allowed: SlotKey " +
  '{ namespace: "default", task_queue: "orchestrator" }, worker_instance_key: WorkerTaskTypes ' +
  "{ enable_workflows: true, enable_local_activities: true, enable_remote_activities: true, " +
  "enable_nexus: false } build_id: None, new task types: WorkerTaskTypes { enable_workflows: true, " +
  "enable_local_activities: true, enable_remote_activities: true, enable_nexus: false }, " +
  "existing task types: 5a159ab8-f9ea-4679-9c18-be7e058db98a.";

describe("worker registration overlap matcher (#1073)", () => {
  it("matches the exact error the failing CI job produced", () => {
    expect(WORKER_REGISTRATION_OVERLAP_RE.test(REAL_CI_ERROR)).toBe(true);
  });

  it("matches when the error arrives as an Error (String()d, as makeWorker does)", () => {
    expect(
      WORKER_REGISTRATION_OVERLAP_RE.test(String(new Error(REAL_CI_ERROR))),
    ).toBe(true);
  });

  it("ignores the varying tail — the uuid and task-type list must not be part of the match", () => {
    // Same failure, different worker instance and a future task type. If the regex ever grows to
    // cover the tail, THIS is the test that fails rather than a rare CI red months later.
    const variant = REAL_CI_ERROR.replace(
      "5a159ab8-f9ea-4679-9c18-be7e058db98a",
      "ffffffff-0000-4000-8000-ffffffffffff",
    ).replace("enable_nexus: false", "enable_nexus: true");
    expect(WORKER_REGISTRATION_OVERLAP_RE.test(variant)).toBe(true);
  });

  it("does NOT match unrelated Worker.create failures — those must fail fast, not retry", () => {
    for (const other of [
      "Failed to initialize worker: connection refused",
      "Could not find workflow bundle at /nope/workflows.js",
      "TransportError: tonic::transport::Error(Transport, ConnectError)",
      "Registration failed", // superficially similar, not the same failure
    ]) {
      expect(
        WORKER_REGISTRATION_OVERLAP_RE.test(other),
        `must not retry: ${other}`,
      ).toBe(false);
    }
  });
});
