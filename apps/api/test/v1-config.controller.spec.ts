import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1ConfigController } from "../src/v1/v1-config.controller";

/**
 * The v1 config controller is thin glue over VariablesService / EnvSecretsService / UsageService — its
 * job is (1) call the SAME service the SPA uses, (2) resolve the env from the token's selector, and
 * (3) map into a v1-OWNED response (§5). These tests pin the delegation args, the env resolution, the
 * DTO seam, and the ONE non-negotiable: secrets are WRITE-ONLY — no endpoint returns a secret value
 * (CLAUDE.md Tier-1 §4).
 */

const variables = { list: vi.fn(), upsert: vi.fn(), remove: vi.fn() };
const secrets = { list: vi.fn(), set: vi.fn(), remove: vi.fn() };
const usage = { getUsage: vi.fn(), getInsights: vi.fn() };
const environments = { resolveEnvId: vi.fn() };

let ctrl: V1ConfigController;
beforeEach(() => {
  vi.clearAllMocks();
  environments.resolveEnvId.mockResolvedValue("env-1");
  ctrl = new V1ConfigController(
    variables as never,
    secrets as never,
    usage as never,
    environments as never,
  );
});

describe("V1ConfigController — variables", () => {
  it("list resolves the env and maps VariableView[] to { key, value }", async () => {
    variables.list.mockResolvedValue([
      { key: "API_BASE_URL", value: "https://api.example.com" },
    ]);

    const out = await ctrl.listVariables("t-1", "sandbox");

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    expect(variables.list).toHaveBeenCalledWith("t-1", "env-1");
    expect(out).toEqual([
      { key: "API_BASE_URL", value: "https://api.example.com" },
    ]);
  });

  it("set delegates (tenantId, envId, key, value) and maps the result", async () => {
    variables.upsert.mockResolvedValue({ key: "FOO", value: "bar" });

    const out = await ctrl.setVariable("t-1", "FOO", { value: "bar" }, "prod");

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "prod");
    expect(variables.upsert).toHaveBeenCalledWith("t-1", "env-1", "FOO", "bar");
    expect(out).toEqual({ key: "FOO", value: "bar" });
  });

  it("delete delegates and returns { deleted: true }", async () => {
    variables.remove.mockResolvedValue(undefined);

    const out = await ctrl.removeVariable("t-1", "FOO", undefined);

    expect(variables.remove).toHaveBeenCalledWith("t-1", "env-1", "FOO");
    expect(out).toEqual({ deleted: true });
  });
});

describe("V1ConfigController — secrets (WRITE-ONLY)", () => {
  it("list maps NAMES to { name } — and the response carries NO value field", async () => {
    secrets.list.mockResolvedValue(["STRIPE_KEY", "OPENAI_KEY"]);

    const out = await ctrl.listSecrets("t-1", "sandbox");

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    expect(secrets.list).toHaveBeenCalledWith("t-1", "env-1");
    expect(out).toEqual([{ name: "STRIPE_KEY" }, { name: "OPENAI_KEY" }]);
    // The write-only invariant (Tier-1 §4): a secret value must never appear in a GET response.
    for (const row of out) {
      expect(Object.keys(row)).toEqual(["name"]);
      expect(row).not.toHaveProperty("value");
    }
  });

  it("set delegates (tenantId, envId, name, value) and returns { ok: true } — no value echoed", async () => {
    secrets.set.mockResolvedValue(undefined);

    const out = await ctrl.setSecret(
      "t-1",
      "STRIPE_KEY",
      { value: "sk-live-123" },
      "prod",
    );

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "prod");
    expect(secrets.set).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "STRIPE_KEY",
      "sk-live-123",
    );
    // The ack must not carry the value back (write-only invariant).
    expect(out).toEqual({ ok: true });
    expect(out).not.toHaveProperty("value");
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
  });

  it("delete delegates and returns { deleted: true }", async () => {
    secrets.remove.mockResolvedValue(undefined);

    const out = await ctrl.removeSecret("t-1", "STRIPE_KEY", undefined);

    expect(secrets.remove).toHaveBeenCalledWith("t-1", "env-1", "STRIPE_KEY");
    expect(out).toEqual({ deleted: true });
  });
});

describe("V1ConfigController — usage", () => {
  it("passes ?from&to through and maps the UsageSummary to the v1 shape", async () => {
    usage.getUsage.mockResolvedValue({
      totalCostUsd: 1.2345,
      totalTokens: 123456,
      byModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4",
          calls: 12,
          totalTokens: 34567,
          costUsd: 0.4213,
        },
      ],
      events: [
        {
          id: "u-1",
          executionId: "run-1",
          nodeId: "agent-1",
          provider: "anthropic",
          model: "claude-sonnet-4",
          inputTokens: 1200,
          outputTokens: 340,
          totalTokens: 1540,
          costUsd: 0.018,
          createdAt: new Date("2026-07-04T12:00:00.000Z"),
        },
      ],
    });

    const out = await ctrl.getUsage("t-1", "2026-07-01", "2026-07-15");

    // tenant from the token; from/to passed straight through (usage is not env-scoped).
    expect(usage.getUsage).toHaveBeenCalledWith(
      "t-1",
      "2026-07-01",
      "2026-07-15",
    );
    expect(out.totalCostUsd).toBe(1.2345);
    expect(out.totalTokens).toBe(123456);
    expect(out.byModel).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4",
        calls: 12,
        totalTokens: 34567,
        costUsd: 0.4213,
      },
    ]);
    expect(out.events[0]).toEqual({
      id: "u-1",
      executionId: "run-1",
      nodeId: "agent-1",
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      costUsd: 0.018,
      createdAt: "2026-07-04T12:00:00.000Z",
    });
  });

  it("works with no window (both from/to omitted)", async () => {
    usage.getUsage.mockResolvedValue({
      totalCostUsd: 0,
      totalTokens: 0,
      byModel: [],
      events: [],
    });

    const out = await ctrl.getUsage("t-1", undefined, undefined);

    expect(usage.getUsage).toHaveBeenCalledWith("t-1", undefined, undefined);
    expect(out).toEqual({
      totalCostUsd: 0,
      totalTokens: 0,
      byModel: [],
      events: [],
    });
  });
});

describe("V1ConfigController — insights", () => {
  const INSIGHTS = {
    range: { from: "2026-07-01", to: null },
    totals: { costUsd: 0.36, totalTokens: 360, calls: 4 },
    byDay: [{ date: "2026-07-16", costUsd: 0.15, totalTokens: 150, calls: 2 }],
    byEnvironment: [
      { environmentId: "env-prod", costUsd: 0.2, totalTokens: 200, calls: 1 },
      { environmentId: null, costUsd: 0.16, totalTokens: 160, calls: 3 },
    ],
    byWorkflow: [
      { workflowKey: "triage", costUsd: 0.2, totalTokens: 200, calls: 1 },
      { workflowKey: null, costUsd: 0.16, totalTokens: 160, calls: 3 },
    ],
    byModel: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4",
        calls: 4,
        totalTokens: 360,
        costUsd: 0.36,
      },
    ],
  };

  it("passes ?from&to&environmentId through and maps the rollup to the v1 shape", async () => {
    usage.getInsights.mockResolvedValue(INSIGHTS);

    const out = await ctrl.getInsights(
      "t-1",
      "2026-07-01",
      "2026-07-31",
      "env-prod",
    );

    // tenant from the token; the env filter is an explicit query param (cross-env rollup).
    expect(usage.getInsights).toHaveBeenCalledWith("t-1", {
      from: "2026-07-01",
      to: "2026-07-31",
      environmentId: "env-prod",
    });
    expect(out).toEqual(INSIGHTS);
    // null env/workflow buckets survive the mapping (not dropped).
    expect(out.byEnvironment[1].environmentId).toBeNull();
    expect(out.byWorkflow[1].workflowKey).toBeNull();
  });

  it("works with no window / no env filter (all params omitted)", async () => {
    usage.getInsights.mockResolvedValue({
      range: { from: null, to: null },
      totals: { costUsd: 0, totalTokens: 0, calls: 0 },
      byDay: [],
      byEnvironment: [],
      byWorkflow: [],
      byModel: [],
    });

    await ctrl.getInsights("t-1", undefined, undefined, undefined);

    expect(usage.getInsights).toHaveBeenCalledWith("t-1", {
      from: undefined,
      to: undefined,
      environmentId: undefined,
    });
  });
});
