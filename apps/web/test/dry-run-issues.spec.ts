import { describe, expect, it } from "vitest";
import { summarizeDryRun } from "../src/lib/dry-run-issues";
import type { DryRunResult } from "../src/lib/api/types";

/**
 * The dry-run summary's job is to be honest about COVERAGE, not just about failures. The number
 * that misleads is "0 problems" on a flow where nothing could actually be checked (#835).
 */

const result = (over: Partial<DryRunResult> = {}): DryRunResult => ({
  ok: true,
  probed: 1,
  unprobeable: 0,
  nodes: [],
  ...over,
});

describe("summarizeDryRun", () => {
  it("turns each failed check into a clickable row, tagged by layer", () => {
    const s = summarizeDryRun(
      result({
        ok: false,
        nodes: [
          {
            nodeId: "ack",
            type: "integration",
            checks: [
              {
                kind: "config",
                ok: false,
                message: "missing required field: title",
              },
              {
                kind: "credential",
                ok: false,
                message: "PagerDuty answered 401",
              },
            ],
          },
        ],
      }),
    );

    expect(s.issues).toHaveLength(2);
    expect(s.issues.every((i) => i.nodeId === "ack")).toBe(true);
    expect(s.issues.map((i) => i.field)).toEqual(["config", "connection"]);
    expect(s.issues[0].message).toContain("title");
    expect(s.issues.every((i) => i.kind === "check")).toBe(true);
  });

  it("does NOT create a row for a passing or skipped check", () => {
    const s = summarizeDryRun(
      result({
        unprobeable: 1,
        nodes: [
          {
            nodeId: "issue",
            type: "integration",
            checks: [
              { kind: "config", ok: true },
              {
                kind: "credential",
                ok: true,
                skipped: true,
                message: "no probe exists",
              },
            ],
          },
        ],
      }),
    );

    expect(s.issues).toEqual([]);
  });

  /** The point of the whole summary line: silence about what was skipped is the misleading part. */
  it("says what could NOT be checked, even when nothing failed", () => {
    const s = summarizeDryRun(result({ probed: 0, unprobeable: 1 }));

    expect(s.message).toContain("No problems found");
    expect(s.message).toMatch(/could not be checked/);
    expect(s.message).toMatch(/unverified/);
  });

  /** Zero issues is not the same as a clean check — the pill's colour depends on this flag. */
  it("reports ok only when the check ran AND found nothing", () => {
    expect(summarizeDryRun(result()).ok).toBe(true);
    expect(
      summarizeDryRun(
        result({
          ok: false,
          nodes: [
            {
              nodeId: "a",
              type: "integration",
              checks: [{ kind: "config", ok: false, message: "x" }],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("reads correctly for more than one unverified connection", () => {
    const one = summarizeDryRun(result({ unprobeable: 1 })).message;
    const many = summarizeDryRun(result({ unprobeable: 3 })).message;

    expect(one).toContain("1 connection could not be checked");
    expect(one).toMatch(/this provider has .*its credentials/);
    expect(many).toContain("3 connections could not be checked");
    expect(many).toMatch(/those providers have .*their credentials/);
  });

  it("does not mention unverified connections when there are none", () => {
    const s = summarizeDryRun(result({ probed: 2 }));

    expect(s.message).toContain("2 connections verified");
    expect(s.message).not.toMatch(/could not be checked/);
  });

  it("counts problems, not nodes", () => {
    const s = summarizeDryRun(
      result({
        ok: false,
        nodes: [
          {
            nodeId: "a",
            type: "integration",
            checks: [
              { kind: "config", ok: false, message: "x" },
              { kind: "request", ok: false, message: "y" },
            ],
          },
          {
            nodeId: "b",
            type: "integration",
            checks: [{ kind: "config", ok: false, message: "z" }],
          },
        ],
      }),
    );

    expect(s.issues).toHaveLength(3);
    expect(s.message).toContain("3 problems");
  });

  it("falls back to a readable message when the server sends none", () => {
    const s = summarizeDryRun(
      result({
        ok: false,
        nodes: [
          {
            nodeId: "a",
            type: "integration",
            checks: [{ kind: "request", ok: false }],
          },
        ],
      }),
    );

    expect(s.issues[0].message).toBe("The request check failed.");
  });
});
