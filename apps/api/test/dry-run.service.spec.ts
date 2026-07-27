import { describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";
import { INTEGRATION_PROVIDERS, pickConnectionTestAction } from "@naary/dsl";
import { DryRunService } from "../src/graphs/dry-run.service";
import type { ConnectionTestService } from "../src/connections/connection-test.service";

/**
 * DRY RUN (#832) — "will this flow run?" answered without running it.
 *
 * The problem it exists for (#830): a generated flow's problems were discoverable only by running
 * it, one failure per run. The property that makes it usable on a real flow is that it executes
 * NOTHING — asserted here rather than promised in a comment.
 */

const testFn = (result: unknown) =>
  vi.fn().mockResolvedValue(result) as unknown as ConnectionTestService["test"];

const svc = (test: ConnectionTestService["test"]) =>
  new DryRunService({ test } as ConnectionTestService);

const OK_PROBE = {
  ok: true,
  status: "ok",
  httpStatus: 200,
  checkedAction: "pagerduty.list_incidents",
  connectionStatus: "connected",
  message: "PagerDuty answered 200 — this connection works.",
};

/** A complete, valid PagerDuty node. */
const node = (over: Record<string, unknown> = {}) => ({
  id: "ack",
  type: "integration" as const,
  config: {
    provider: "pagerduty",
    action: "list_incidents",
    connectionId: "conn-pd",
    fields: {},
    ...over,
  },
});

const graph = (...nodes: ReturnType<typeof node>[]): GraphDef => ({
  startNodeId: "start",
  nodes: [{ id: "start", type: "start" }, ...nodes, { id: "end", type: "end" }],
  edges: [],
});

describe("DryRunService", () => {
  it("passes a well-formed flow and probes its connection once", async () => {
    const test = testFn(OK_PROBE);
    const res = await svc(test).check("t-1", graph(node()));

    expect(res.ok).toBe(true);
    expect(res.probed).toBe(1);
    expect(res.nodes[0].checks.map((c) => c.kind)).toEqual([
      "config",
      "request",
      "credential",
    ]);
  });

  /** The verdict is about the CREDENTIAL, so six nodes on one connection cost one call. */
  it("probes a shared connection only once", async () => {
    const test = testFn(OK_PROBE);
    const res = await svc(test).check(
      "t-1",
      graph(node(), { ...node(), id: "ack2" }, { ...node(), id: "ack3" }),
    );

    expect(res.probed).toBe(1);
    expect(test).toHaveBeenCalledTimes(1);
    // …and every node still gets the verdict.
    for (const n of res.nodes) {
      expect(n.checks.some((c) => c.kind === "credential" && c.ok)).toBe(true);
    }
  });

  it("reports a dead credential WITHOUT running anything", async () => {
    const test = testFn({
      ...OK_PROBE,
      ok: false,
      status: "failed",
      httpStatus: 401,
      message: "PagerDuty answered 401 — the token was rejected.",
    });

    const res = await svc(test).check("t-1", graph(node()));

    expect(res.ok).toBe(false);
    const cred = res.nodes[0].checks.find((c) => c.kind === "credential");
    expect(cred?.ok).toBe(false);
    expect(cred?.message).toContain("401");
  });

  it("catches a missing required field without building or sending that request", async () => {
    const test = testFn(OK_PROBE);
    const res = await svc(test).check(
      "t-1",
      // create_incident requires fields; supplying none is the classic generator miss.
      graph(node({ action: "create_incident", fields: {} })),
    );

    const config = res.nodes[0].checks.find((c) => c.kind === "config");
    expect(config?.ok).toBe(false);
    expect(config?.message).toMatch(/missing required field/);
    // The request check is SKIPPED when config already failed — restating it adds nothing.
    expect(res.nodes[0].checks.some((c) => c.kind === "request")).toBe(false);
    expect(res.ok).toBe(false);
  });

  /**
   * The credential probe is NOT short-circuited by a config failure, and that is on purpose:
   * "is this token alive?" is a different question from "are the fields filled in", and its
   * answer is just as true on a node that has both problems. Reporting one problem per check is
   * the fix-run-repeat loop the dry run exists to end (#830).
   */
  it("still reports a dead token on a node whose config is ALSO wrong", async () => {
    const test = testFn({
      ...OK_PROBE,
      ok: false,
      status: "failed",
      httpStatus: 401,
      message: "PagerDuty answered 401 — the token was rejected.",
    });

    const res = await svc(test).check(
      "t-1",
      graph(node({ action: "create_incident", fields: {} })),
    );

    const checks = res.nodes[0].checks;
    expect(checks.find((c) => c.kind === "config")?.ok).toBe(false);
    // Both problems in ONE result, so both get fixed before the next check.
    expect(checks.find((c) => c.kind === "credential")?.message).toContain(
      "401",
    );
    expect(test).toHaveBeenCalledTimes(1);
  });

  /**
   * A provider with no zero-argument read (GitHub) can't be probed. That is NOT a failure —
   * reporting it as one would train people to ignore the result.
   */
  it("treats an unprobeable provider as skipped, not failed", async () => {
    const test = testFn({
      ...OK_PROBE,
      ok: false,
      status: "unknown",
      httpStatus: null,
      checkedAction: null,
      message: "No zero-argument read exists for this provider.",
    });

    const res = await svc(test).check(
      "t-1",
      graph(
        node({
          provider: "github",
          action: "get_issue",
          fields: { owner: "a", repo: "b", issueNumber: 1 },
        }),
      ),
    );

    const cred = res.nodes[0].checks.find((c) => c.kind === "credential");
    expect(cred?.skipped).toBe(true);
    expect(res.ok).toBe(true); // a skipped check must not fail the flow
    // …and it is NOT counted as a probe: no request was made, so counting it would overstate both
    // the cost and how much the run actually verified.
    expect(res.probed).toBe(0);
    expect(res.unprobeable).toBe(1);
  });

  /** An unreachable provider is a RESULT, not an exception that loses the other nodes' verdicts. */
  it("survives a probe that throws", async () => {
    const test = vi
      .fn()
      .mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND"),
      ) as unknown as ConnectionTestService["test"];

    const res = await svc(test).check("t-1", graph(node()));

    expect(res.ok).toBe(false);
    expect(
      res.nodes[0].checks.find((c) => c.kind === "credential")?.message,
    ).toContain("ENOTFOUND");
  });

  it("ignores non-integration nodes", async () => {
    const test = testFn(OK_PROBE);
    const res = await svc(test).check("t-1", {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", config: { prompt: "hi" } },
        { id: "end", type: "end" },
      ],
      edges: [],
    });

    expect(res.nodes).toEqual([]);
    expect(res.ok).toBe(true);
    expect(test).not.toHaveBeenCalled();
  });
});

/**
 * THE SAFETY PROPERTY, asserted against the CATALOG rather than against this service: the probe
 * action a dry run can reach is chosen by `pickConnectionTestAction`, which filters on the
 * catalog's own `write` flag. So "a dry run never fires a write action" holds by construction —
 * and this test fails if a future catalog edit marks a probe action as a write.
 */
describe("dry run can never reach a write action", () => {
  it("every provider's probe action is write:false", () => {
    let checked = 0;
    for (const provider of INTEGRATION_PROVIDERS) {
      const probe = pickConnectionTestAction(provider.key);
      // `unknown` = we declined to probe this provider at all, which is safe by definition.
      if (probe.kind !== "read") continue;
      const action = provider.actions.find((a) => a.key === probe.action);
      expect(
        action,
        `${provider.key}.${probe.action} is not in the catalog`,
      ).toBeDefined();
      expect(
        action?.write,
        `${provider.key}.${probe.action} must be a read`,
      ).toBe(false);
      checked += 1;
    }
    // Without this the test passes vacuously if the probe union is ever renamed — which is
    // precisely what happened when this was written against a `kind` value that never existed.
    // 14 of 38 providers are probeable today; the floor only has to rule out "zero" (#835).
    expect(checked, "no provider was actually checked").toBeGreaterThan(10);
  });
});
