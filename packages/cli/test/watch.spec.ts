import { describe, expect, it } from "vitest";
import {
  TERMINAL_STATUSES,
  exitCodeFor,
  isSuccess,
  isTerminal,
  watchRun,
  type RunSnapshot,
} from "../src/watch";

describe("terminal-status detection", () => {
  it("recognizes every terminal status", () => {
    for (const s of TERMINAL_STATUSES) expect(isTerminal(s)).toBe(true);
  });
  it("treats running/queued as non-terminal", () => {
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
  });
});

describe("--exit-code mapping", () => {
  it("exits 0 ONLY for completed", () => {
    expect(exitCodeFor("completed")).toBe(0);
    expect(isSuccess("completed")).toBe(true);
  });
  it("exits non-zero for every other terminal status", () => {
    for (const s of TERMINAL_STATUSES) {
      if (s === "completed") continue;
      expect(exitCodeFor(s)).toBe(1);
    }
  });
});

describe("watchRun", () => {
  it("polls until terminal and reports the initial status + each transition", async () => {
    const seq: RunSnapshot[] = [
      { runId: "r1", status: "queued" },
      { runId: "r1", status: "running" },
      { runId: "r1", status: "running" },
      { runId: "r1", status: "completed", output: { ok: true } },
    ];
    let i = 0;
    const transitions: string[] = [];
    const final = await watchRun("r1", {
      getRun: async () => seq[Math.min(i++, seq.length - 1)],
      onTransition: (status) => transitions.push(status),
      sleep: async () => {},
    });
    // queued (initial), running (change), completed (change) — the duplicate running is not re-emitted.
    expect(transitions).toEqual(["queued", "running", "completed"]);
    expect(final.status).toBe("completed");
    expect(exitCodeFor(final.status)).toBe(0);
  });

  it("stops immediately when the first snapshot is already terminal", async () => {
    let calls = 0;
    const final = await watchRun("r1", {
      getRun: async () => {
        calls++;
        return { runId: "r1", status: "failed" };
      },
      onTransition: () => {},
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(final.status).toBe("failed");
    expect(exitCodeFor(final.status)).toBe(1);
  });

  it("honors maxPolls as a safety cap for a never-terminal run", async () => {
    let calls = 0;
    await watchRun("r1", {
      getRun: async () => {
        calls++;
        return { runId: "r1", status: "running" };
      },
      onTransition: () => {},
      sleep: async () => {},
      maxPolls: 3,
    });
    expect(calls).toBe(3);
  });
});
