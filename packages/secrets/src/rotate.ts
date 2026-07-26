import { getPrisma } from "@naary/db";
import {
  type EncryptedPayload,
  type KeyEncryptor,
  createKeyEncryptor,
} from "./crypto";
import { TENANT_KEY_VERSION, TenantKeyService, dekAad } from "./tenant-keys";

/**
 * Master-key rotation rewrap. Run with the NEW key as ENCRYPTION_KEY and the OLD
 * key(s) in OLD_ENCRYPTION_KEY (createKeyEncryptor then decrypts old material via
 * the fallback chain while encrypting with the new key). Three passes:
 *
 *  1. TenantKey rows — unwrap each DEK (old or new master), re-wrap under the NEW
 *     master. After this, OLD_ENCRYPTION_KEY is no longer needed for v3 data.
 *  2. Legacy TenantCredential rows (keyVersion < 3, i.e. master-encrypted) —
 *     decrypt with the master chain and CONVERGE to v3 under the tenant's DEK.
 *  3. WebhookEndpoint signing secrets (JSON payload blobs) below v3 — same
 *     convergence.
 *
 * After a clean run, nothing at rest is encrypted under the old master:
 * OLD_ENCRYPTION_KEY can be dropped from the environment. Idempotent — re-running
 * re-wraps DEKs under the (same) primary and finds no sub-v3 rows.
 *
 * Per-row failures are collected (id + error NAME only — never key material or
 * messages, which could carry payload fragments) and never abort the sweep.
 */
export interface RotateFailure {
  table: "TenantKey" | "TenantCredential" | "WebhookEndpoint";
  id: string;
  errorName: string;
}

export interface RotateResult {
  tenantKeysRewrapped: number;
  credentialsConverged: number;
  webhookSecretsConverged: number;
  failures: RotateFailure[];
}

export async function rotateMasterKey(opts?: {
  /** Master chain override (tests). Default: createKeyEncryptor() — new primary + old fallbacks. */
  master?: KeyEncryptor;
  /** Report what WOULD change without writing anything. */
  dryRun?: boolean;
}): Promise<RotateResult> {
  const master = opts?.master ?? createKeyEncryptor();
  const dryRun = opts?.dryRun ?? false;
  const keys = new TenantKeyService({ master });
  const prisma = getPrisma();
  const result: RotateResult = {
    tenantKeysRewrapped: 0,
    credentialsConverged: 0,
    webhookSecretsConverged: 0,
    failures: [],
  };
  const fail = (table: RotateFailure["table"], id: string, err: unknown) =>
    result.failures.push({
      table,
      id,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });

  // Pass 1: re-wrap every DEK under the NEW primary master.
  for (const row of await prisma.tenantKey.findMany()) {
    try {
      const dekHex = master.decrypt(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
          keyVersion: row.keyVersion,
        },
        dekAad(row.tenantId),
      );
      if (!dryRun) {
        const wrapped = master.encrypt(dekHex, dekAad(row.tenantId));
        await prisma.tenantKey.update({
          where: { tenantId: row.tenantId },
          data: {
            ciphertext: wrapped.ciphertext,
            iv: wrapped.iv,
            authTag: wrapped.authTag,
            keyVersion: wrapped.keyVersion ?? 1,
          },
        });
      }
      result.tenantKeysRewrapped++;
    } catch (err) {
      fail("TenantKey", row.tenantId, err);
    }
  }

  // Pass 2: converge legacy master-encrypted credential/secret rows to v3 (tenant DEK).
  // `gt: 0` skips EXTERNAL rows (#458): keyVersion 0 means the material lives in Vault/ASM and
  // the crypto columns are empty, so it is neither legacy nor rewrappable. Without this the
  // sweep would try to master-decrypt empty ciphertext, record every Vault-backed row as a
  // failure, and the rotation runbook could never be certified complete (it tells the operator
  // to keep OLD_ENCRYPTION_KEY set while failures remain).
  const legacyCreds = await prisma.tenantCredential.findMany({
    where: { keyVersion: { lt: TENANT_KEY_VERSION, gt: 0 } },
  });
  for (const row of legacyCreds) {
    try {
      const aad = `${row.tenantId}:${row.provider}`;
      const plaintext = master.decrypt(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
          keyVersion: row.keyVersion,
        },
        aad,
      );
      if (!dryRun) {
        const enc = await keys.encrypt(row.tenantId, plaintext, aad);
        await prisma.tenantCredential.update({
          where: { id: row.id },
          data: {
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            authTag: enc.authTag,
            keyVersion: enc.keyVersion ?? 1,
          },
        });
      }
      result.credentialsConverged++;
    } catch (err) {
      fail("TenantCredential", row.id, err);
    }
  }

  // Pass 3: webhook signing secrets (payload stored as a JSON blob; AAD = tenantId).
  for (const row of await prisma.webhookEndpoint.findMany({
    select: { id: true, tenantId: true, signingSecret: true },
  })) {
    try {
      const payload = JSON.parse(row.signingSecret) as EncryptedPayload;
      if ((payload.keyVersion ?? 1) >= TENANT_KEY_VERSION) continue; // already v3
      const plaintext = master.decrypt(payload, row.tenantId);
      if (!dryRun) {
        const enc = await keys.encrypt(row.tenantId, plaintext, row.tenantId);
        await prisma.webhookEndpoint.update({
          where: { id: row.id },
          data: { signingSecret: JSON.stringify(enc) },
        });
      }
      result.webhookSecretsConverged++;
    } catch (err) {
      fail("WebhookEndpoint", row.id, err);
    }
  }

  return result;
}
