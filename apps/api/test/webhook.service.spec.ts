import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AesGcmKeyEncryptor } from "@naary/secrets";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryDeleteMany: vi.fn(),
}));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    webhookEndpoint: { create: m.create, findMany: m.findMany },
    webhookDelivery: {
      create: m.deliveryCreate,
      deleteMany: m.deliveryDeleteMany,
    },
  }),
}));

import { WebhookService } from "../src/webhooks/webhook.service";

// Inject a real encryptor (random key) so createEndpoint can encrypt the secret
// at rest without depending on a process ENCRYPTION_KEY.
const svc = new WebhookService(
  new AesGcmKeyEncryptor(randomBytes(32).toString("hex")),
);
const SECRET = "top-secret-hmac-key";
const RAW = Buffer.from('{"action":"opened","number":42}');
const sign = (body: Buffer, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

beforeEach(() => {
  m.create.mockReset();
  m.findMany.mockReset();
  m.deliveryCreate.mockReset();
  m.deliveryDeleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("WebhookService.list", () => {
  it("lists the tenant's endpoints newest-first WITHOUT the signing secret (Sec#8)", async () => {
    const now = new Date();
    m.findMany.mockResolvedValue([
      { id: "ep_1", provider: "github", workflowId: "wf-1", createdAt: now },
    ]);

    const rows = await svc.list("t1");

    // scoped to the tenant, ordered desc, and the secret is excluded at the
    // query level so it can never reach the response.
    const arg = m.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t1" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.select).toEqual({
      id: true,
      provider: true,
      workflowId: true,
      createdAt: true,
    });
    expect(arg.select).not.toHaveProperty("signingSecret");

    expect(rows).toEqual([
      { id: "ep_1", provider: "github", workflowId: "wf-1", createdAt: now },
    ]);
    expect(rows[0]).not.toHaveProperty("signingSecret");
  });
});

describe("WebhookService.createEndpoint", () => {
  it("returns an ingress path + a generated signing secret", async () => {
    m.create.mockResolvedValue({ id: "ep_1" });
    const reg = await svc.createEndpoint("t1", "wf-1", "github");
    expect(reg.endpointId).toBe("ep_1");
    expect(reg.ingressPath).toBe("/hooks/ep_1");
    expect(reg.signingSecret).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes hex
  });

  it("stores the signing secret ENCRYPTED at rest and round-trips it (Sec#8)", async () => {
    m.create.mockResolvedValue({ id: "ep_2" });
    const reg = await svc.createEndpoint("t1", "wf-1", "github");
    const stored = m.create.mock.calls[0][0].data.signingSecret as string;
    // the persisted column is ciphertext, not the plaintext key
    expect(stored).not.toContain(reg.signingSecret);
    expect(JSON.parse(stored)).toHaveProperty("ciphertext");
    // and it decrypts back for HMAC verification (AAD bound to the tenant, Sec#7)
    expect(
      svc.decryptSigningSecret({
        signingSecret: stored,
        tenantId: "t1",
      } as never),
    ).toBe(reg.signingSecret);
    // a wrong-tenant AAD must fail to decrypt (row-swap detection)
    expect(() =>
      svc.decryptSigningSecret({
        signingSecret: stored,
        tenantId: "t2",
      } as never),
    ).toThrow();
  });
});

describe("WebhookService.verifySignature (GitHub HMAC over raw body)", () => {
  it("accepts a correct signature", () => {
    expect(svc.verifySignature("github", RAW, sign(RAW, SECRET), SECRET)).toBe(
      true,
    );
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const tampered = Buffer.from('{"action":"closed","number":42}');
    expect(
      svc.verifySignature("github", tampered, sign(RAW, SECRET), SECRET),
    ).toBe(false);
  });

  it("rejects a wrong secret and a missing header", () => {
    expect(svc.verifySignature("github", RAW, sign(RAW, "wrong"), SECRET)).toBe(
      false,
    );
    expect(svc.verifySignature("github", RAW, undefined, SECRET)).toBe(false);
  });

  it("fails closed for atlassian (scheme not implemented)", () => {
    expect(
      svc.verifySignature("atlassian", RAW, sign(RAW, SECRET), SECRET),
    ).toBe(false);
  });
});

describe("WebhookService.isDuplicateDelivery", () => {
  it("returns false first time, true on a duplicate (Prisma P2002)", async () => {
    m.deliveryCreate.mockResolvedValueOnce({ id: "d1" });
    expect(await svc.isDuplicateDelivery("ep_1", "delivery-abc")).toBe(false);

    m.deliveryCreate.mockRejectedValueOnce({ code: "P2002" });
    expect(await svc.isDuplicateDelivery("ep_1", "delivery-abc")).toBe(true);
  });

  it("prunes this endpoint's dedupe rows past the retention window on a new delivery (Sec#9)", async () => {
    m.deliveryCreate.mockResolvedValueOnce({ id: "d3" });
    await svc.isDuplicateDelivery("ep_1", "delivery-new");

    expect(m.deliveryDeleteMany).toHaveBeenCalledOnce();
    const { where } = m.deliveryDeleteMany.mock.calls[0][0];
    expect(where.endpointId).toBe("ep_1");
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // cutoff is ~30 days ago
    const ageMs = Date.now() - (where.createdAt.lt as Date).getTime();
    expect(ageMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it("does NOT prune on a duplicate (P2002 short-circuits before retention)", async () => {
    m.deliveryCreate.mockRejectedValueOnce({ code: "P2002" });
    expect(await svc.isDuplicateDelivery("ep_1", "dup")).toBe(true);
    expect(m.deliveryDeleteMany).not.toHaveBeenCalled();
  });

  it("rethrows non-P2002 errors (does not swallow real failures)", async () => {
    m.deliveryCreate.mockRejectedValueOnce({
      code: "P1001",
      message: "db down",
    });
    await expect(svc.isDuplicateDelivery("ep_1", "d2")).rejects.toMatchObject({
      code: "P1001",
    });
  });
});
