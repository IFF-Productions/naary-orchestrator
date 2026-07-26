import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import {
  MemoryObjectStore,
  type ObjectStore,
  getObjectStore,
} from "@naary/storage";
import {
  type AssetContentType,
  MAX_ASSET_BYTES,
  checkAssetBytes,
} from "./form-asset";

/**
 * Prisma's unique-constraint violation. Matched on the CODE rather than the message so it survives a
 * Prisma version bump, and without importing the error class (which pulls the generated client's
 * runtime into a module that is otherwise cheap to load in tests).
 */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "P2002";
}

/** A stored asset, as the serve route needs it. */
export interface StoredAsset {
  contentType: string;
  bytes: Buffer;
  sha256: string;
}

/** An asset's metadata WITHOUT its bytes — enough to answer a conditional request. */
export interface AssetMeta {
  contentType: string;
  sha256: string;
}

/**
 * Read a request body into a Buffer, ABORTING once it exceeds `limit`.
 *
 * The upload route can't lean on the global JSON body parser: `express.json()` is content-type gated
 * and skips a body labelled `image/png` entirely, so nothing has consumed or bounded the stream by
 * the time the handler runs. Raising the global JSON limit instead would loosen it for every endpoint
 * — including the anonymous form/chat ingress, whose tight body cap is a documented protection — so
 * the bound belongs here, on the one route that needs a large body.
 *
 * Destroys the socket on overflow rather than draining it: a caller streaming a gigabyte must not get
 * to keep streaming after we've decided to refuse it. Same bounded-read shape as `readCapped` in
 * connection-test.service.ts.
 */
export function readBodyCapped(
  req: IncomingMessage,
  limit = MAX_ASSET_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new BadRequestException(message));
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        fail(`Image is larger than ${Math.floor(limit / 1024)} KB.`);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => fail("Upload failed."));
    req.on("aborted", () => fail("Upload aborted."));
  });
}

/**
 * Storage for hosted-page images (today: form logos). Bytes go to object storage via the
 * `@naary/storage` ObjectStore seam (S3 in production); Postgres holds only the metadata index.
 *
 * ## Why an upload REFUSES when object storage isn't configured
 *
 * `getObjectStore()` silently falls back to `MemoryObjectStore` when `STORAGE_PROVIDER` is unset —
 * correct for the claim-check path (a dev run offloading a large node output round-trips within one
 * process) but catastrophic here. A logo written to that store lives in ONE api process's heap: it
 * disappears on the next `docker-rollout` and is invisible to every other replica, so a
 * customer-facing form would show a broken image intermittently, depending on which container served
 * the request. Nothing would log an error.
 *
 * A silent half-failure on a public page is worse than a loud refusal, so `assertDurableStore` turns
 * "no bucket configured" into a 503 that names the env vars. The check is structural (`instanceof`)
 * rather than an env-var re-read, so it can't drift from what `getObjectStore()` actually returned.
 */
@Injectable()
export class FormAssetService {
  // Test seam: inject a store rather than reaching for the env-configured singleton.
  constructor(private readonly objects: ObjectStore = getObjectStore()) {}

  /**
   * Fail loudly when the configured store can't outlive the process. See the class doc — the
   * alternative is a logo that works in staging and intermittently 404s in production.
   */
  private assertDurableStore(): void {
    if (this.objects instanceof MemoryObjectStore) {
      throw new ServiceUnavailableException(
        "Image uploads need object storage. Set STORAGE_PROVIDER=s3 and S3_BUCKET (plus AWS_REGION " +
          "and credentials) on the API — without them an uploaded logo would not survive a redeploy.",
      );
    }
  }

  /**
   * Validate and store an uploaded logo, returning its id.
   *
   * Content-addressed on the sha256: identical bytes reuse the existing row AND object key, so a
   * tenant re-picking the same file doesn't accumulate copies. That's also what makes the served id
   * safe to cache immutably — an id's image can never change, because different bytes are a different
   * id.
   */
  async store(
    tenantId: string,
    environmentId: string,
    bytes: Buffer,
    kind = "logo",
  ): Promise<{ assetId: string; contentType: AssetContentType }> {
    this.assertDurableStore();

    // Magic-byte check — the request's Content-Type is a claim and is used for nothing.
    const check = checkAssetBytes(bytes);
    if (!check.ok) throw new BadRequestException(check.error);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = await getPrisma().formAsset.findUnique({
      where: {
        tenantId_environmentId_kind_sha256: {
          tenantId,
          environmentId,
          kind,
          sha256,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { assetId: existing.id, contentType: check.contentType };
    }

    // Key by tenant + env + content hash: tenant-partitioned for lifecycle/cleanup, and the hash
    // makes the write idempotent (re-uploading the same bytes overwrites an identical object).
    const key = `form-assets/${tenantId}/${environmentId}/${kind}/${sha256}`;
    const objectRef = await this.objects.put(key, bytes);

    const data = {
      tenantId,
      environmentId,
      kind,
      contentType: check.contentType,
      objectRef,
      byteSize: bytes.length,
      sha256,
    };
    try {
      const row = await getPrisma().formAsset.create({
        data,
        select: { id: true },
      });
      return { assetId: row.id, contentType: check.contentType };
    } catch (e) {
      // Two concurrent uploads of the SAME file (a double-clicked picker, two authors, a retry) can
      // both miss the findUnique above and race to create. One loses the composite unique and would
      // 500 — for a request whose intent was already satisfied by the winner. Re-read and return the
      // winner's id instead: the object is byte-identical, so there is nothing to reconcile.
      if (!isUniqueViolation(e)) throw e;
      const winner = await getPrisma().formAsset.findUnique({
        where: {
          tenantId_environmentId_kind_sha256: {
            tenantId,
            environmentId,
            kind,
            sha256,
          },
        },
        select: { id: true },
      });
      // Absent only if the winner was deleted between the conflict and this read — genuinely
      // exceptional, so surface the original error rather than inventing an id.
      if (!winner) throw e;
      return { assetId: winner.id, contentType: check.contentType };
    }
  }

  /**
   * An asset's content type + hash, WITHOUT fetching the bytes.
   *
   * This is what makes the serve route's ETag worth having. A form logo is requested on every view of
   * a public page, and the hash lives in Postgres — so a conditional request can be answered with one
   * indexed row read and a 304, skipping both the S3 GetObject and the response body. Without this,
   * `get()` would have already downloaded the bytes before there was anything to compare, and the
   * ETag would save only bandwidth, never a storage round-trip.
   */
  async getMeta(assetId: string): Promise<AssetMeta | null> {
    return getPrisma().formAsset.findUnique({
      where: { id: assetId },
      select: { contentType: true, sha256: true },
    });
  }

  /**
   * Fetch an asset by id for the PUBLIC serve route — deliberately NOT tenant-scoped.
   *
   * The id is an opaque uuid and the only capability, exactly like `formId`: the anonymous browser
   * rendering a hosted form has no tenant context to scope by. Nothing in the response identifies the
   * owning tenant, so serving it reveals only the image the form already displays.
   *
   * Returns null both for an unknown id and for a row whose object has gone missing (a bucket
   * lifecycle rule, a restored database ahead of its bucket) — the caller 404s either way rather than
   * 500ing, because a missing logo must not take down the page it decorates.
   */
  async get(assetId: string): Promise<StoredAsset | null> {
    const row = await getPrisma().formAsset.findUnique({
      where: { id: assetId },
      select: { contentType: true, objectRef: true, sha256: true },
    });
    if (!row) return null;
    try {
      const bytes = await this.objects.get(row.objectRef);
      return { contentType: row.contentType, bytes, sha256: row.sha256 };
    } catch {
      // Deliberately swallowed: the ref is ours, the failure is storage-side, and the honest answer
      // to the browser is "no image here" rather than a 500 on a form that otherwise works.
      return null;
    }
  }

  /**
   * Does this asset belong to this tenant+env? Used to reject a `logoAssetId` pointing at another
   * tenant's asset before it's saved into a graph.
   *
   * Without it, a tenant could reference an id learned from another workspace's public form and serve
   * it as their own — cross-tenant hotlinking of an asset we host and pay for. One indexed lookup.
   */
  async ownedBy(
    assetId: string,
    tenantId: string,
    environmentId: string,
  ): Promise<boolean> {
    const row = await getPrisma().formAsset.findFirst({
      where: { id: assetId, tenantId, environmentId },
      select: { id: true },
    });
    return row !== null;
  }
}
