import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AesGcmKeyEncryptor } from "@naary/secrets";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  deliveryCreate: vi.fn(),
}));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    webhookEndpoint: { create: m.create },
    webhookDelivery: { create: m.deliveryCreate },
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
  m.deliveryCreate.mockReset();
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
