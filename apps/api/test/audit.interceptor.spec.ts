import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditInterceptor } from "../src/audit/audit.interceptor";
import { actionFor, type AuditService } from "../src/audit/audit.service";

const record = vi.fn();
function makeInterceptor(): AuditInterceptor {
  return new AuditInterceptor({ record } as unknown as AuditService);
}

function ctx(req: {
  method: string;
  path: string;
  principal?: { tenantId: string; subject?: string };
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

beforeEach(() => record.mockReset());

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
});
