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
    expect(() => controller.getGuardrails("t1", principal(role))).toThrow(
      ForbiddenException,
    );
    expect(() => controller.saveGuardrails("t1", {}, principal(role))).toThrow(
      ForbiddenException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("allows role %s", async (role) => {
    findUnique.mockResolvedValue({ agentGuardrails: POLICY });
    await expect(
      controller.getGuardrails("t1", principal(role)),
    ).resolves.toEqual(POLICY);
    await expect(
      controller.saveGuardrails("t1", POLICY, principal(role)),
    ).resolves.toEqual(POLICY);
  });

  it("allows an actor-less internal call (no principal ⇒ no role to check)", async () => {
    findUnique.mockResolvedValue({ agentGuardrails: POLICY });
    await expect(controller.getGuardrails("t1")).resolves.toEqual(POLICY);
  });
});
