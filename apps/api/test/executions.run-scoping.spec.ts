import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// RBAC G3 (§8.4) — run-read scoping + approve/cancel gating. The deferred leak closes
// here: a restricted member/token must not see run rows (or run detail/ctx/history) of
// workflows it cannot view, and approve/cancel are `run`-gated. Trigger/internal callers
// and the PUBLIC signed-link approval path carry no actor and stay byte-identical.

const findMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findMany, findUnique } }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import type {
  EffectivePermissions,
  PermissionsService,
} from "../src/permissions/permissions.service";
import { ExecutionsService } from "../src/executions/executions.service";

const member: Principal = { tenantId: "t-1", userId: "u-1", role: "member" };

/** Build an EffectivePermissions with the given view access (other verbs irrelevant here). */
function eff(view: { all: boolean; keys: string[] }, restricted = true) {
  const none = { all: false, keys: [] };
  return {
    restricted,
    canCreate: false,
    view,
    run: none,
    edit: none,
    delete: none,
    share: none,
  } as EffectivePermissions;
}

const FULL = eff({ all: true, keys: [] }, false);

interface PermsMock {
  getEffective: ReturnType<typeof vi.fn>;
  assertCan: ReturnType<typeof vi.fn>;
  can: ReturnType<typeof vi.fn>;
}

function makePerms(over: Partial<PermsMock> = {}): PermsMock {
  return {
    getEffective: vi.fn().mockResolvedValue(FULL),
    assertCan: vi.fn().mockResolvedValue(undefined),
    can: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

function makeService(opts: {
  perms?: PermsMock | undefined;
  /** tenant envs for the list filter (default: prod default + sandbox). */
  envs?: { id: string; isDefault: boolean }[];
  getHandle?: (id: string) => unknown;
  wirePerms?: boolean;
}): ExecutionsService {
  const envs = opts.envs ?? [
    { id: "env-prod", isDefault: true },
    { id: "env-sandbox", isDefault: false },
  ];
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-prod",
      resolveEnvId: async () => "env-prod",
      list: async () => envs,
    } as never,
    opts.wirePerms === false
      ? undefined
      : (opts.perms as unknown as PermissionsService),
  );
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: opts.getHandle ?? (() => ({})) },
  };
  return service;
}

function row(over: Record<string, unknown> = {}) {
  return {
    workflowId: "wf-1",
    tenantId: "t-1",
    workflowKey: "refunds",
    environmentId: "env-prod",
    status: "completed", // terminal → no Temporal reconcile in list paths
    costUsd: null,
    createdAt: new Date("2026-07-10T00:00:00Z"),
    archivedAt: null,
    graphVersion: 1,
    ...over,
  };
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  findUnique.mockReset().mockResolvedValue(row());
});

// ---------------------------------------------------------------------------
// listPage — the view filter is pushed INTO the where clause (pagination exact).
// ---------------------------------------------------------------------------
describe("listPage view scoping (G3 §8.4)", () => {
  it("restricted subject: env-exact OR terms composed via AND (keyset math untouched)", async () => {
    const perms = makePerms({
      getEffective: vi
        .fn()
        .mockImplementation(async (_p: Principal, envId?: string) => {
          if (envId === "env-prod") return eff({ all: true, keys: [] });
          if (envId === "env-sandbox")
            return eff({ all: false, keys: ["wf-a", "wf-b"] });
          return eff({ all: false, keys: [] }); // the restriction probe (no env)
        }),
    });
    await makeService({ perms }).listPage("t-1", { limit: 10 }, member);

    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
      AND: [
        {
          OR: [
            {
              // view-all in prod: every KEYED run there; a NULL workflowKey row is
              // NEVER visible to a restricted subject. The default env also owns
              // legacy env-less rows.
              workflowKey: { not: null },
              OR: [{ environmentId: "env-prod" }, { environmentId: null }],
            },
            {
              workflowKey: { in: ["wf-a", "wf-b"] },
              environmentId: "env-sandbox",
            },
          ],
        },
      ],
    });
  });

  it("restricted subject with NOTHING viewable matches no rows (OR: [])", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
    });
    const out = await makeService({ perms }).listPage("t-1", {}, member);
    expect(findMany.mock.calls[0][0].where.AND).toEqual([{ OR: [] }]);
    expect(out.items).toEqual([]);
  });

  it("an UNRESTRICTED actor's query is byte-identical (no AND fragment)", async () => {
    const perms = makePerms(); // getEffective → restricted:false
    await makeService({ perms }).listPage("t-1", { limit: 5 }, member);
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
    });
  });

  it("an actor-LESS call (internal/company rollup) never consults permissions", async () => {
    const perms = makePerms();
    await makeService({ perms }).listPage("t-1", { limit: 5 });
    expect(perms.getEffective).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
    });
  });

  it("the view filter COMPOSES with the cursor keyset (AND beside the keyset OR)", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: ["k"] })),
    });
    const cursor = Buffer.from(
      JSON.stringify({ t: "2026-07-01T00:00:00.000Z", id: "wf-9" }),
      "utf8",
    ).toString("base64url");
    await makeService({ perms }).listPage("t-1", { cursor }, member);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(2); // the keyset filter survives at the top level
    expect(where.AND).toHaveLength(1); // the view filter rides separately
  });

  it("list() (the SPA Runs screen) threads the actor into the same filter", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
    });
    await makeService({ perms }).list("t-1", 50, false, member);
    expect(findMany.mock.calls[0][0].where.AND).toEqual([{ OR: [] }]);
  });

  it("fails CLOSED when an actor is passed but permissions are not wired", async () => {
    const service = makeService({ wirePerms: false });
    await expect(service.listPage("t-1", {}, member)).rejects.toThrow(
      /PermissionsService is not wired/,
    );
  });
});

// ---------------------------------------------------------------------------
// Single-run reads: getState / history / runGraph assert `view` on the run's
// OWN workflow + environment, after the tenant assertOwner.
// ---------------------------------------------------------------------------
describe("run detail view gating (G3 §8.4)", () => {
  it("getState 403s a restricted subject without view on the run's workflow", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({ perms });
    await expect(
      service.getState("wf-1", "t-1", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Asserted view against the run's OWN key + env (from the Execution row).
    expect(perms.assertCan).toHaveBeenCalledWith(
      member,
      "view",
      "refunds",
      "env-prod",
    );
  });

  it("getState proceeds for a granted subject", async () => {
    const perms = makePerms({
      getEffective: vi
        .fn()
        .mockResolvedValue(eff({ all: false, keys: ["refunds"] })),
    });
    const service = makeService({
      perms,
      getHandle: () => ({
        describe: async () => ({ status: { name: "RUNNING" } }),
        query: async () => ({
          status: "running",
          currentNodeId: "n1",
          ctx: {},
        }),
      }),
    });
    const out = await service.getState("wf-1", "t-1", member);
    expect(out.status).toBe("running");
  });

  it("a KEY-LESS legacy run is visible only to UNRESTRICTED subjects", async () => {
    findUnique.mockResolvedValue(row({ workflowKey: null }));
    const restricted = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: true, keys: [] })),
    });
    await expect(
      makeService({ perms: restricted }).getState("wf-1", "t-1", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Never reached assertCan — there is no key to assert against.
    expect(restricted.assertCan).not.toHaveBeenCalled();

    const bypassed = makePerms(); // restricted:false
    const service = makeService({
      perms: bypassed,
      getHandle: () => ({
        describe: async () => ({ status: { name: "RUNNING" } }),
        query: async () => ({ status: "running", currentNodeId: "", ctx: {} }),
      }),
    });
    await expect(service.getState("wf-1", "t-1", member)).resolves.toBeTruthy();
  });

  it("a run without an env tag asserts against the tenant DEFAULT env", async () => {
    findUnique.mockResolvedValue(row({ environmentId: null }));
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: ["x"] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    await expect(
      makeService({ perms }).getState("wf-1", "t-1", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(perms.assertCan).toHaveBeenCalledWith(
      member,
      "view",
      "refunds",
      "env-prod", // defaultEnvId fallback
    );
  });

  it("history and runGraph are view-gated the same way", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({ perms });
    await expect(service.history("wf-1", "t-1", member)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.runGraph("wf-1", "t-1", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("actor-less getState (internal caller) never consults permissions", async () => {
    const perms = makePerms();
    const service = makeService({
      perms,
      getHandle: () => ({
        describe: async () => ({ status: { name: "RUNNING" } }),
        query: async () => ({ status: "running", currentNodeId: "", ctx: {} }),
      }),
    });
    await service.getState("wf-1", "t-1");
    expect(perms.getEffective).not.toHaveBeenCalled();
    expect(perms.assertCan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// approve / cancel: run-control actions assert `run` on the run's workflow.
// ---------------------------------------------------------------------------
describe("approve/cancel run gating (G3)", () => {
  it("approve 403s a restricted subject without `run`; the signal is never sent", async () => {
    const signal = vi.fn();
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({ perms, getHandle: () => ({ signal }) });
    await expect(
      service.approve("wf-1", true, "t-1", undefined, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(perms.assertCan).toHaveBeenCalledWith(
      member,
      "run",
      "refunds",
      "env-prod",
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it("approve proceeds for a granted subject; actor-less approve is ungated", async () => {
    const signal = vi.fn();
    const perms = makePerms({
      getEffective: vi
        .fn()
        .mockResolvedValue(eff({ all: false, keys: ["refunds"] })),
    });
    const service = makeService({ perms, getHandle: () => ({ signal }) });
    await service.approve("wf-1", true, "t-1", undefined, member);
    expect(signal).toHaveBeenCalledTimes(1);

    await service.approve("wf-1", false, "t-1"); // no actor — MCP-internal/legacy shape
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it("cancel 403s a restricted subject without `run`; terminate never fires", async () => {
    const terminate = vi.fn();
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({ perms, getHandle: () => ({ terminate }) });
    await expect(service.cancel("wf-1", "t-1", member)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(terminate).not.toHaveBeenCalled();

    const granted = makeService({
      perms: makePerms(),
      getHandle: () => ({ terminate }),
    });
    await granted.cancel("wf-1", "t-1", member);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("approveBatch threads the actor into every per-run decision", async () => {
    const perms = makePerms({
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({
      perms,
      getHandle: () => ({ signal: vi.fn() }),
    });
    const out = await service.approveBatch(
      ["wf-1", "wf-2"],
      true,
      "t-1",
      undefined,
      member,
    );
    expect(out.every((r) => !r.ok)).toBe(true);
    expect(perms.assertCan).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Approvals inbox: filtered for restricted subjects, untouched otherwise.
// ---------------------------------------------------------------------------
describe("listAwaiting view filtering (G3)", () => {
  const awaitingRows = [
    row({
      workflowId: "wf-a",
      workflowKey: "visible",
      status: "awaiting_approval",
    }),
    row({
      workflowId: "wf-b",
      workflowKey: "hidden",
      status: "awaiting_approval",
    }),
    row({ workflowId: "wf-c", workflowKey: null, status: "awaiting_approval" }),
  ];
  const liveHandle = () => ({
    query: async () => ({
      status: "awaiting_approval",
      currentNodeId: "gate",
      ctx: {},
    }),
  });

  it("a restricted subject's inbox shows only viewable workflows (key-less rows hidden)", async () => {
    findMany.mockResolvedValue(awaitingRows);
    const perms = makePerms({
      getEffective: vi
        .fn()
        .mockResolvedValue(eff({ all: false, keys: ["visible"] })),
      can: vi
        .fn()
        .mockImplementation(
          async (_p: Principal, _a: string, key: string) => key === "visible",
        ),
    });
    const service = makeService({ perms, getHandle: liveHandle });
    // approvalPrompt reads the graph — stub it out (not under test here).
    (service as unknown as { graphs: unknown }).graphs = {
      getLatest: async () => null,
    };
    const out = await service.listAwaiting("t-1", member);
    expect(out.map((r) => r.workflowId)).toEqual(["wf-a"]);
    // The invisible rows never cost a Temporal query either — but the visible one did.
    expect(perms.can).toHaveBeenCalledWith(
      member,
      "view",
      "visible",
      "env-prod",
    );
  });

  it("an unrestricted actor (and an actor-less caller) sees the whole inbox", async () => {
    findMany.mockResolvedValue(awaitingRows);
    const perms = makePerms(); // restricted:false
    const service = makeService({ perms, getHandle: liveHandle });
    (service as unknown as { graphs: unknown }).graphs = {
      getLatest: async () => null,
    };
    expect(await service.listAwaiting("t-1", member)).toHaveLength(3);
    expect(perms.can).not.toHaveBeenCalled();

    findMany.mockResolvedValue(awaitingRows);
    expect(await service.listAwaiting("t-1")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING NEGATIVE: the PUBLIC signed-link approval path (HMAC-authorized)
// must stay ungated — it has no principal and never consults permissions.
// ---------------------------------------------------------------------------
describe("signed-link approval path stays ungated (regression)", () => {
  it("decideByToken signals without ANY permission consultation (even when wired)", async () => {
    const signal = vi.fn();
    const perms = makePerms({
      // If the path ever consulted permissions this would deny — proving it doesn't.
      getEffective: vi.fn().mockResolvedValue(eff({ all: false, keys: [] })),
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
      can: vi.fn().mockResolvedValue(false),
    });
    const service = makeService({
      perms,
      getHandle: () => ({
        query: async () => ({
          status: "awaiting_approval",
          currentNodeId: "g",
          ctx: {},
        }),
        signal,
      }),
    });
    await service.decideByToken("wf-1", true, "lgtm");
    expect(signal).toHaveBeenCalledTimes(1);
    expect(perms.getEffective).not.toHaveBeenCalled();
    expect(perms.assertCan).not.toHaveBeenCalled();
    expect(perms.can).not.toHaveBeenCalled();
    // It never even reads the Execution row for authz — the HMAC token IS the credential.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("decideByToken works with NO PermissionsService wired at all", async () => {
    const signal = vi.fn();
    const service = makeService({
      wirePerms: false,
      getHandle: () => ({
        query: async () => ({
          status: "awaiting_approval",
          currentNodeId: "g",
          ctx: {},
        }),
        signal,
      }),
    });
    await expect(service.decideByToken("wf-1", false)).resolves.toBeUndefined();
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it("resumeByToken (webhook resume ingress) is equally untouched", async () => {
    const signal = vi.fn();
    const perms = makePerms({
      assertCan: vi.fn().mockRejectedValue(new ForbiddenException("no")),
    });
    const service = makeService({ perms, getHandle: () => ({ signal }) });
    await service.resumeByToken("wf-1", { ok: true });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(perms.assertCan).not.toHaveBeenCalled();
  });
});
