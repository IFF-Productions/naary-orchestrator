import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getPrisma, type WebhookEndpoint } from "@naary/db";
import {
  type KeyEncryptor,
  TenantKeyService,
  getTenantKeyService,
} from "@naary/secrets";

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

/** Public view of a registered webhook — NEVER includes the signing secret. */
export interface WebhookEndpointView {
  id: string;
  provider: string;
  workflowId: string;
  createdAt: Date;
}

@Injectable()
export class WebhookService {
  // Lazily built so constructing the service doesn't require ENCRYPTION_KEY until
  // a secret is actually encrypted/decrypted (keeps pure verify tests hermetic).
  // Signing secrets use the same per-tenant ENVELOPE encryption as the credential
  // store (tenant DEK, keyVersion 3); pre-envelope master-encrypted blobs keep
  // decrypting via the keyVersion route in TenantKeyService.
  private _keys?: TenantKeyService;
  private readonly _master?: KeyEncryptor;
  constructor(encryptor?: KeyEncryptor, tenantKeys?: TenantKeyService) {
    this._master = encryptor;
    this._keys = tenantKeys;
  }
  private get keys(): TenantKeyService {
    return (this._keys ??= this._master
      ? new TenantKeyService({ master: this._master })
      : getTenantKeyService());
  }

  /**
   * Register a webhook trigger: mint a signing secret + stable ingress path.
   * The secret is the HMAC key; it is stored ENCRYPTED at rest (Sec#8) and
   * returned in plaintext exactly once so the user can configure the provider.
   */
  async createEndpoint(
    tenantId: string,
    environmentId: string,
    workflowId: string,
    provider: WebhookProvider,
  ): Promise<RegisteredWebhook> {
    const signingSecret = randomBytes(32).toString("hex");
    const row = await getPrisma().webhookEndpoint.create({
      data: {
        tenantId,
        environmentId,
        workflowId,
        provider,
        // store the encrypted payload as a JSON blob in the existing column;
        // tenant-DEK encrypted, AAD-bound to the tenant (Sec#7)
        signingSecret: JSON.stringify(
          await this.keys.encrypt(tenantId, signingSecret, tenantId),
        ),
      },
    });
    return {
      endpointId: row.id,
      ingressPath: `/hooks/${row.id}`,
      signingSecret,
    };
  }

  /**
   * List the tenant's registered webhook endpoints (newest first). The signing
   * secret is excluded at the query level (`select`) so it never leaves the DB
   * layer (Sec#8) — there is no path for it to reach the API response.
   */
  list(tenantId: string): Promise<WebhookEndpointView[]> {
    return getPrisma().webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, provider: true, workflowId: true, createdAt: true },
    });
  }

  /**
   * Update a webhook endpoint's configuration IN PLACE — retarget the workflow it triggers
   * and/or change the provider (signature/delivery scheme). The endpoint id, ingress URL and
   * signing secret are UNCHANGED, so the provider's config keeps working. Tenant-scoped (can't
   * touch another tenant's). Returns the updated view, or null if the endpoint isn't this
   * tenant's (→ 404). To rotate the secret, use rotateSecret.
   */
  async updateEndpoint(
    tenantId: string,
    endpointId: string,
    patch: { workflowId?: string; provider?: WebhookProvider },
  ): Promise<WebhookEndpointView | null> {
    const data: { workflowId?: string; provider?: string } = {};
    if (patch.workflowId !== undefined) data.workflowId = patch.workflowId;
    if (patch.provider !== undefined) data.provider = patch.provider;
    if (Object.keys(data).length > 0) {
      const res = await getPrisma().webhookEndpoint.updateMany({
        where: { id: endpointId, tenantId },
        data,
      });
      if (res.count === 0) return null; // not this tenant's / unknown
    }
    // Re-read tenant-scoped (also serves an empty patch as "fetch current, 404 if not owned").
    return getPrisma().webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
      select: { id: true, provider: true, workflowId: true, createdAt: true },
    });
  }

  /**
   * Rotate a webhook endpoint's signing secret: mint a NEW secret, store it encrypted, and
   * return the plaintext exactly once (like creation). The endpoint id/URL are unchanged — only
   * the HMAC key. Any provider still signing with the old secret will fail verification until
   * reconfigured. Tenant-scoped; null if the endpoint isn't this tenant's (→ 404).
   */
  async rotateSecret(
    tenantId: string,
    endpointId: string,
  ): Promise<{ signingSecret: string } | null> {
    const owned = await getPrisma().webhookEndpoint.findFirst({
      where: { id: endpointId, tenantId },
      select: { id: true },
    });
    if (!owned) return null;
    const signingSecret = randomBytes(32).toString("hex");
    await getPrisma().webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        signingSecret: JSON.stringify(
          await this.keys.encrypt(tenantId, signingSecret, tenantId),
        ),
      },
    });
    return { signingSecret };
  }

  /** Delete a tenant's webhook endpoint by id (tenant-scoped so it can't touch another's).
   *  Returns true if a row was removed. Any inbound call to that ingress then 404s. */
  async deleteEndpoint(tenantId: string, endpointId: string): Promise<boolean> {
    const res = await getPrisma().webhookEndpoint.deleteMany({
      where: { id: endpointId, tenantId },
    });
    return res.count > 0;
  }

  /** Decrypt an endpoint's stored signing secret (in memory only; never logged).
   *  Routed by keyVersion: v3 → tenant DEK; pre-envelope v1/v2 → master key. */
  decryptSigningSecret(endpoint: WebhookEndpoint): Promise<string> {
    return this.keys.decrypt(
      endpoint.tenantId,
      JSON.parse(endpoint.signingSecret),
      endpoint.tenantId,
    );
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

  /** Dedupe rows older than this are pruned (Sec#9) — providers don't replay
   *  deliveries this old, so it doubles as the replay window. */
  static readonly DEDUPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  /**
   * Record a delivery id; returns true if it was ALREADY seen (duplicate).
   * Relies on the @@unique([endpointId, deliveryId]) constraint — catches the
   * specific Prisma P2002 so real errors still surface. On a NEW delivery it also
   * opportunistically prunes this endpoint's dedupe rows past the retention window
   * so the table can't grow unbounded (Sec#9) — best-effort, never fails ingress.
   */
  async isDuplicateDelivery(
    endpointId: string,
    deliveryId: string,
  ): Promise<boolean> {
    try {
      await getPrisma().webhookDelivery.create({
        data: { endpointId, deliveryId },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return true;
      throw e;
    }

    const cutoff = new Date(Date.now() - WebhookService.DEDUPE_RETENTION_MS);
    await getPrisma()
      .webhookDelivery.deleteMany({
        where: { endpointId, createdAt: { lt: cutoff } },
      })
      .catch(() => undefined); // retention is best-effort; don't fail the webhook
    return false;
  }

  /**
   * Undo a dedupe record — used to ROLL BACK when the run fails to start after we
   * recorded the delivery. Without this, a transient start failure (workflow inactive,
   * Temporal down) would burn the delivery id for the whole retention window, so every
   * provider retry returns `duplicate_ignored` and the run never fires. Best-effort:
   * if the delete itself fails, the caller still surfaces the original start error
   * (the provider retries; worst case the id stays recorded, i.e. today's behavior).
   */
  async removeDelivery(endpointId: string, deliveryId: string): Promise<void> {
    await getPrisma()
      .webhookDelivery.deleteMany({ where: { endpointId, deliveryId } })
      .catch(() => undefined);
  }
}
