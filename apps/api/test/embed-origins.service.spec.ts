import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma accessor before importing the service (same pattern as
// turnstile-config.service.spec.ts).
const formEndpoint = { findUnique: vi.fn() };
const chatEndpoint = { findUnique: vi.fn() };
const turnstileConfig = { findUnique: vi.fn() };
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ formEndpoint, chatEndpoint, turnstileConfig }),
}));

import { EmbedOriginsService } from "../src/common/embed-origins.service";

beforeEach(() => {
  formEndpoint.findUnique.mockReset();
  chatEndpoint.findUnique.mockReset();
  turnstileConfig.findUnique.mockReset();
});

describe("EmbedOriginsService (#617)", () => {
  it("resolves a form path → the tenant/env's SHARED allowed hostnames", async () => {
    formEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    turnstileConfig.findUnique.mockResolvedValue({
      allowedHostnames: ["example.com"],
    });
    const service = new EmbedOriginsService();
    expect(await service.allowedHostnamesForPath("/forms/f-1")).toEqual([
      "example.com",
    ]);
    // It reads the SAME row the Turnstile hostname check uses — one list, not two.
    expect(turnstileConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_environmentId: { tenantId: "t-1", environmentId: "e-1" },
        },
      }),
    );
  });

  it("resolves a chat path via ChatEndpoint", async () => {
    chatEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-2",
      environmentId: "e-2",
    });
    turnstileConfig.findUnique.mockResolvedValue({
      allowedHostnames: ["chat.example.com"],
    });
    const service = new EmbedOriginsService();
    expect(await service.allowedHostnamesForPath("/chat/c-1")).toEqual([
      "chat.example.com",
    ]);
    expect(formEndpoint.findUnique).not.toHaveBeenCalled();
  });

  it("is UNRESTRICTED ([]) with no Turnstile row — today's state for every tenant", async () => {
    formEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    turnstileConfig.findUnique.mockResolvedValue(null);
    expect(
      await new EmbedOriginsService().allowedHostnamesForPath("/forms/f-1"),
    ).toEqual([]);
  });

  it("is UNRESTRICTED for an unknown id and for a non-embed path (no DB hit)", async () => {
    formEndpoint.findUnique.mockResolvedValue(null);
    const service = new EmbedOriginsService();
    expect(await service.allowedHostnamesForPath("/forms/nope")).toEqual([]);
    expect(await service.allowedHostnamesForPath("/executions")).toEqual([]);
    expect(chatEndpoint.findUnique).not.toHaveBeenCalled();
  });

  it("fails PERMISSIVE (and does not cache) when the DB throws", async () => {
    formEndpoint.findUnique.mockRejectedValueOnce(new Error("db down"));
    const service = new EmbedOriginsService();
    expect(await service.allowedHostnamesForPath("/forms/f-1")).toEqual([]);
    // Not cached: the next call retries and now succeeds.
    formEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    turnstileConfig.findUnique.mockResolvedValue({
      allowedHostnames: ["example.com"],
    });
    expect(await service.allowedHostnamesForPath("/forms/f-1")).toEqual([
      "example.com",
    ]);
  });

  it("memoizes per id, and invalidate() forces a re-read (a Settings write calls it)", async () => {
    formEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    turnstileConfig.findUnique.mockResolvedValue({
      allowedHostnames: ["example.com"],
    });
    const service = new EmbedOriginsService();
    await service.allowedHostnamesForPath("/forms/f-1");
    await service.allowedHostnamesForPath("/forms/f-1");
    expect(formEndpoint.findUnique).toHaveBeenCalledTimes(1);

    turnstileConfig.findUnique.mockResolvedValue({ allowedHostnames: [] });
    service.invalidate();
    expect(await service.allowedHostnamesForPath("/forms/f-1")).toEqual([]);
    expect(formEndpoint.findUnique).toHaveBeenCalledTimes(2);
  });

  it("returns ONLY hostnames — never a tenant/env/workflow id", async () => {
    formEndpoint.findUnique.mockResolvedValue({
      tenantId: "t-secret",
      environmentId: "e-secret",
    });
    turnstileConfig.findUnique.mockResolvedValue({
      allowedHostnames: ["example.com"],
    });
    const out = await new EmbedOriginsService().allowedHostnamesForPath(
      "/forms/f-1",
    );
    expect(JSON.stringify(out)).not.toContain("t-secret");
    expect(JSON.stringify(out)).not.toContain("e-secret");
  });
});
