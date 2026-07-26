// Agent guardrails (#576) — the workspace policy read/write surface and its owner/admin gate.
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getPrisma: () => ({ tenantSettings: { findUnique, upsert } }),
}));

import { GuardrailsService } from "../src/settings/guardrails.service";
import { SettingsController } from "../src/settings/settings.controller";
import { SettingsService } from "../src/settings/settings.service";
import type { Principal } from "../src/auth/tenant.decorator";

const guardrails = new GuardrailsService();
const controller = new SettingsController(new SettingsService(), guardrails);

const principal = (role: string): Principal =>
  ({ tenantId: "t1", subject: "u1", role }) as unknown as Principal;

const POLICY = {
  tools: { deny: ["delete_*"], requireApproval: ["wire_money"] },
  redact: { enabled: true, kinds: ["email"] },
};

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset().mockResolvedValue({});
});

describe("GuardrailsService", () => {
  it("returns {} when no policy is stored", async () => {
    findUnique.mockResolvedValue(null);
    expect(await guardrails.get("t1")).toEqual({});
    findUnique.mockResolvedValue({ agentGuardrails: null });
    expect(await guardrails.get("t1")).toEqual({});
  });

  it("round-trips a stored policy", async () => {
    findUnique.mockResolvedValue({ agentGuardrails: POLICY });
    expect(await guardrails.get("t1")).toEqual(POLICY);
  });

  it("a MALFORMED stored policy is a visible 400, never a silent 'no guardrails'", async () => {
    findUnique.mockResolvedValue({ agentGuardrails: { tools: "nope" } });
    await expect(guardrails.get("t1")).rejects.toThrow(BadRequestException);
  });

  it("save validates with the SAME zod schema the worker parses with, and rejects a typo'd key", async () => {
    await expect(
      guardrails.save("t1", { tools: { denny: ["x"] } }),
    ).rejects.toThrow(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("save upserts the whole object, tenant-scoped", async () => {
    await expect(guardrails.save("t1", POLICY)).resolves.toEqual(POLICY);
    expect(upsert.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(upsert.mock.calls[0][0].update).toEqual({
      agentGuardrails: POLICY,
    });
  });

  it("save treats a missing body as the EMPTY policy (an explicit clear, still validated)", async () => {
    await expect(guardrails.save("t1", undefined)).resolves.toEqual({});
  });
});

describe("guardrail routes are OWNER/ADMIN only", () => {
  // Clearing the policy zeroes ALL THREE enforcement points at once (the activity short-circuits,
  // resolveToolPolicy returns nothing restricted, and the save gate becomes a no-op), so a member
  // holding `edit` on a workflow must not be able to switch the workspace's controls off.
  it.each(["member", "viewer", "editor"])("403s for role %s", async (role) => {
    findUnique.mockResolvedValue({ agentGuardrails: POLICY });
    // `rejects`, not a sync throw: the routes are async (they await the service), so the
    // ForbiddenException arrives as a rejected promise.
    await expect(
      controller.getGuardrails("t1", principal(role)),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.saveGuardrails("t1", {}, principal(role)),
    ).rejects.toThrow(ForbiddenException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("allows role %s", async (role) => {
    findUnique.mockResolvedValue({ agentGuardrails: POLICY });
    // ENVELOPED — the declared GuardrailPolicyResponse is `{ policy: <object> }`, and the
    // route used to return the bare policy, so every generated client had the wrong shape.
    await expect(
      controller.getGuardrails("t1", principal(role)),
    ).resolves.toEqual({ policy: POLICY });
    await expect(
      controller.saveGuardrails("t1", POLICY, principal(role)),
    ).resolves.toEqual({ policy: POLICY });
  });

  /**
   * FAILS CLOSED with no principal. This previously ASSERTED the opposite ("no principal ⇒ no
   * role to check"), which made an authz gate on the workspace's agent controls dependent on
   * `@CurrentPrincipal()` always resolving — a wiring change elsewhere would have silently
   * opened both routes. An internal, actor-less caller belongs on GuardrailsService directly,
   * not on the HTTP route.
   */
  it.each([undefined, null])(
    "refuses a call with no principal (%s) rather than skipping the role check",
    async (missing) => {
      findUnique.mockResolvedValue({ agentGuardrails: POLICY });
      await expect(
        controller.getGuardrails("t1", missing as never),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.saveGuardrails("t1", POLICY, missing as never),
      ).rejects.toThrow(ForbiddenException);
    },
  );

  it("does not read or write the policy when the principal is missing", async () => {
    findUnique.mockClear();
    upsert.mockClear();
    await expect(
      controller.saveGuardrails("t1", POLICY, undefined as never),
    ).rejects.toThrow(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
