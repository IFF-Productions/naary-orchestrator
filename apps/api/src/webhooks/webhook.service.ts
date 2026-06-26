import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getPrisma, type WebhookEndpoint } from "@naary/db";
import { type KeyEncryptor, createKeyEncryptor } from "@naary/secrets";

export type WebhookProvider = "github" | "atlassian" | "generic";

/** Header carrying the delivery id used for dedupe, per provider. */
const DELIVERY_HEADER: Record<WebhookProvider, string> = {
  github: "x-github-delivery",
  generic: "x-delivery-id",
  atlassian: "x-atlassian-webhook-identifier",
};

export interface RegisteredWebhook {
  endpointId: string;
  /** Path to paste into the provider (GitHub/Jira). Host is deployment-specific. */
  ingressPath: string;
  /** Returned once at creation so the user can configure the provider. */
  signingSecret: string;
}

@Injectable()
export class WebhookService {
  // Lazily built so constructing the service doesn't require ENCRYPTION_KEY until
  // a secret is actually encrypted/decrypted (keeps pure verify tests hermetic).
  private _encryptor?: KeyEncryptor;
  constructor(encryptor?: KeyEncryptor) {
    this._encryptor = encryptor;
  }
  private get encryptor(): KeyEncryptor {
    return (this._encryptor ??= createKeyEncryptor());
  }

  /**
   * Register a webhook trigger: mint a signing secret + stable ingress path.
   * The secret is the HMAC key; it is stored ENCRYPTED at rest (Sec#8) and
   * returned in plaintext exactly once so the user can configure the provider.
   */
  async createEndpoint(
    tenantId: string,
    workflowId: string,
    provider: WebhookProvider,
  ): Promise<RegisteredWebhook> {
    const signingSecret = randomBytes(32).toString("hex");
    const row = await getPrisma().webhookEndpoint.create({
      data: {
        tenantId,
        workflowId,
        provider,
        // store the encrypted payload as a JSON blob in the existing column
        signingSecret: JSON.stringify(this.encryptor.encrypt(signingSecret)),
      },
    });
    return {
      endpointId: row.id,
      ingressPath: `/hooks/${row.id}`,
      signingSecret,
    };
  }

  /** Decrypt an endpoint's stored signing secret (in memory only; never logged). */
  decryptSigningSecret(endpoint: WebhookEndpoint): string {
    return this.encryptor.decrypt(JSON.parse(endpoint.signingSecret));
  }

  getEndpoint(endpointId: string): Promise<WebhookEndpoint | null> {
    return getPrisma().webhookEndpoint.findUnique({
      where: { id: endpointId },
    });
  }

  deliveryHeaderFor(provider: string): string {
    return DELIVERY_HEADER[provider as WebhookProvider] ?? "x-delivery-id";
  }

  /**
   * Verify an HMAC-SHA256 signature over the RAW request bytes (GitHub's
   * `X-Hub-Signature-256: sha256=<hex>` scheme; reused for the generic provider).
   * Length-guarded timing-safe compare — never `===`. Atlassian's inbound scheme
   * differs and is not implemented here (the reference flow is GitHub).
   */
  verifySignature(
    provider: WebhookProvider,
    rawBody: Buffer,
    signatureHeader: string | undefined,
    secret: string,
  ): boolean {
    if (provider === "atlassian") {
      // Atlassian inbound signing is not GitHub-style; verify against current
      // docs before enabling. Treated as unsupported for now (fail closed).
      return false;
    }
    if (!signatureHeader) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
    return timingSafeEqual(a, b);
  }

  /**
   * Record a delivery id; returns true if it was ALREADY seen (duplicate).
   * Relies on the @@unique([endpointId, deliveryId]) constraint — catches the
   * specific Prisma P2002 so real errors still surface.
   */
  async isDuplicateDelivery(
    endpointId: string,
    deliveryId: string,
  ): Promise<boolean> {
    try {
      await getPrisma().webhookDelivery.create({
        data: { endpointId, deliveryId },
      });
      return false;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return true;
      throw e;
    }
  }
}
