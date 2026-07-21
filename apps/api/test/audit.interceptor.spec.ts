import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditInterceptor } from "../src/audit/audit.interceptor";
import { actionFor, type AuditService } from "../src/audit/audit.service";
import type { EnvironmentsService } from "../src/environments/environments.service";

const record = vi.fn();
/** Fake env resolver: id-first-then-slug, mirroring the real resolveEnvId, over a tiny table.
 *  A slug ("sandbox") and its id ("env-sandbox") both resolve to the same canonical id. */
const resolveEnvId = vi.fn(async (_tenantId: string, sel?: string | null) => {
  const table: Record<string, string> = {
    "env-sandbox": "env-sandbox",
    sandbox: "env-sandbox",
    prod: "env-prod",
  };
  const hit = table[(sel ?? "").trim().toLowerCase()] ?? table[sel ?? ""];
  if (!hit) throw new Error(`Unknown environment '${sel}'.`);
  return hit;
});

function makeInterceptor(): AuditInterceptor {
  return new AuditInterceptor(
    { record } as unknown as AuditService,
    { resolveEnvId } as unknown as EnvironmentsService,
  );
}

function ctx(req: {
  method: string;
  path: string;
  principal?: { tenantId: string; subject?: string; environmentSel?: string };
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode: 201 }),
    }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of({ ok: true }) };

/** Run the interceptor pipe to completion (triggers the tap). */
async function run(interceptor: AuditInterceptor, c: ExecutionContext) {
  await new Promise<void>((resolve) => {
    interceptor.intercept(c, next).subscribe({ complete: () => resolve() });
  });
}

beforeEach(() => {
  record.mockReset();
  resolveEnvId.mockClear();
});

describe("AuditInterceptor", () => {
  it("records a successful mutating request with actor + derived action", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/graphs",
        principal: { tenantId: "t-1", subject: "user-9" },
      }),
    );
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      tenantId: "t-1",
      actor: "user-9",
      action: "Saved a workflow",
      method: "POST",
      path: "/graphs",
      statusCode: 201,
    });
  });

  it("falls back to 'api-token' when there's no OIDC subject", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/executions",
        principal: { tenantId: "t-1" },
      }),
    );
    expect(record.mock.calls[0][0].actor).toBe("api-token");
  });

  it("does NOT record a GET (reads aren't audited)", async () => {
    await run(
      makeInterceptor(),
      ctx({ method: "GET", path: "/graphs", principal: { tenantId: "t-1" } }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("does NOT record when there's no principal (unauthenticated)", async () => {
    await run(makeInterceptor(), ctx({ method: "POST", path: "/graphs" }));
    expect(record).not.toHaveBeenCalled();
  });

  it("does NOT audit reads of the audit log itself", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/tenants/t-1/audit",
        principal: { tenantId: "t-1" },
      }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  // #464 — the actor's selected env is resolved to a canonical id and stamped. The resolve
  // happens in an async tap, so let its microtask settle before asserting.
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("stamps the resolved environmentId from a SLUG selection (SPA case)", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/graphs",
        principal: {
          tenantId: "t-1",
          subject: "u-9",
          environmentSel: "sandbox",
        },
      }),
    );
    await settle();
    expect(resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    expect(record.mock.calls[0][0].environmentId).toBe("env-sandbox");
  });

  it("resolves a bound-token UUID selection to the SAME canonical id as the slug", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/graphs",
        principal: { tenantId: "t-1", environmentSel: "env-sandbox" },
      }),
    );
    await settle();
    // The uuid form and the slug form both normalise to the one canonical id — so audit rows
    // from a CI token and from a browser tag the same environment identically.
    expect(record.mock.calls[0][0].environmentId).toBe("env-sandbox");
  });

  it("stamps null when NO env is selected (no default-tagging of env-less actions)", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/tenants/t-1/members",
        principal: { tenantId: "t-1", subject: "u-9" },
      }),
    );
    await settle();
    expect(resolveEnvId).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0].environmentId).toBeNull();
  });

  it("degrades a STALE/unknown env selection to null (never surfaces the throw)", async () => {
    await run(
      makeInterceptor(),
      ctx({
        method: "POST",
        path: "/graphs",
        principal: { tenantId: "t-1", environmentSel: "ghost-env" },
      }),
    );
    await settle();
    // resolveEnvId threw NotFound — the best-effort tap swallows it and still records the row.
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0].environmentId).toBeNull();
  });
});

describe("actionFor", () => {
  it("maps known routes to human labels (id-independent)", () => {
    expect(actionFor("POST", "/graphs")).toBe("Saved a workflow");
    expect(actionFor("POST", "/graphs/generate")).toBe(
      "Generated a workflow with AI",
    );
    expect(actionFor("POST", "/executions/wf-abc/approve")).toBe(
      "Decided an approval",
    );
    expect(actionFor("PUT", "/tenants/t-1/credentials")).toBe(
      "Saved a provider key",
    );
    expect(actionFor("DELETE", "/tenants/t-1/connections/c-9")).toBe(
      "Removed a connection",
    );
    expect(actionFor("PUT", "/tenants/t-1/notifications")).toBe(
      "Updated notifications",
    );
  });

  it("falls back to METHOD + path for anything unmapped", () => {
    expect(actionFor("PATCH", "/something/weird")).toBe(
      "PATCH /something/weird",
    );
  });

  // G3: group/grant/member/token-member mutations get human labels.
  it("maps permission-group routes (G3)", () => {
    expect(actionFor("POST", "/tenants/t-1/groups")).toBe(
      "Created a permission group",
    );
    expect(actionFor("PATCH", "/tenants/t-1/groups/g-1")).toBe(
      "Renamed a permission group",
    );
    expect(actionFor("DELETE", "/tenants/t-1/groups/g-1")).toBe(
      "Deleted a permission group",
    );
    expect(actionFor("POST", "/tenants/t-1/groups/g-1/members/u-9")).toBe(
      "Added a member to a permission group",
    );
    expect(actionFor("DELETE", "/tenants/t-1/groups/g-1/members/u-9")).toBe(
      "Removed a member from a permission group",
    );
    expect(actionFor("POST", "/tenants/t-1/groups/g-1/tokens/tok-3")).toBe(
      "Added an API token to a permission group",
    );
    expect(actionFor("DELETE", "/tenants/t-1/groups/g-1/tokens/tok-3")).toBe(
      "Removed an API token from a permission group",
    );
    expect(actionFor("POST", "/tenants/t-1/groups/g-1/grants")).toBe(
      "Changed workflow permissions",
    );
    expect(actionFor("PATCH", "/tenants/t-1/groups/g-1/grants/gr-2")).toBe(
      "Changed workflow permissions",
    );
    expect(actionFor("DELETE", "/tenants/t-1/groups/g-1/grants/gr-2")).toBe(
      "Removed a workflow permission grant",
    );
  });

  it("maps the U1 team routes (invite semantics, invitations before :userId)", () => {
    expect(actionFor("POST", "/tenants/t-1/members")).toBe("Invited a member");
    expect(actionFor("PATCH", "/tenants/t-1/members/uid-1")).toBe(
      "Changed a member's role",
    );
    expect(actionFor("DELETE", "/tenants/t-1/members/uid-1")).toBe(
      "Removed a member",
    );
    // The literal `invitations` segment must NOT be swallowed by /members/:userId.
    expect(actionFor("DELETE", "/tenants/t-1/members/invitations/inv-1")).toBe(
      "Revoked an invitation",
    );
  });

  it("a group's member attach is never mislabeled as a TEAM member change (order)", () => {
    // Both regexes end in /members/:id — the /groups/ mapping must win.
    expect(actionFor("DELETE", "/tenants/t-1/groups/g-1/members/u-9")).not.toBe(
      "Removed a member",
    );
  });
});
