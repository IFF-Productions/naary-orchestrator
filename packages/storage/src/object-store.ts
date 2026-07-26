import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Provider-agnostic object storage. This interface is the **cloud-portability
 * seam** (CLAUDE.md "platform-agnostic"): AWS S3 is implemented now; a
 * `GcsObjectStore` (Google Cloud Storage) drops in behind the same interface to
 * switch providers without touching callers. `put` returns an opaque reference;
 * `get` resolves it. Used only by activities (I/O) — never workflow code.
 */
export interface ObjectStore {
  put(key: string, data: Buffer | string): Promise<string>;
  get(ref: string): Promise<Buffer>;
}

/** In-memory store — the default when no cloud provider is configured (dev/tests). */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer | string): Promise<string> {
    this.objects.set(key, Buffer.from(data));
    return `mem://${key}`;
  }

  async get(ref: string): Promise<Buffer> {
    const key = ref.replace(/^mem:\/\//, "");
    const value = this.objects.get(key);
    if (!value) throw new Error(`object not found: ${ref}`);
    return value;
  }
}

/** AWS S3 implementation. (GCS is the next impl behind ObjectStore — see factory.) */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, data: Buffer | string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(data),
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }

  async get(ref: string): Promise<Buffer> {
    const match = ref.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) throw new Error(`not an s3 ref: ${ref}`);
    const [, bucket, key] = match;
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`empty object: ${ref}`);
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}

let singleton: ObjectStore | undefined;

/**
 * Build the configured object store from env (cached). `STORAGE_PROVIDER`:
 * `s3` → S3 or any S3-compatible service (`S3_BUCKET`, `AWS_REGION`, optional `S3_ENDPOINT`);
 * anything else (default) → in-memory.
 * To add GCP: a `gcs` branch returning a `GcsObjectStore` — callers are unchanged.
 *
 * `S3_ENDPOINT` targets an S3-compatible provider (Cloudflare R2, Backblaze B2, MinIO). It was
 * documented in deploy/.env.prod.example long before it was read here, so a deployment following
 * those instructions for R2 silently talked to AWS instead and failed to resolve the bucket. Setting
 * an endpoint also forces PATH-style addressing: virtual-host style (`bucket.host`) is an AWS-ism that
 * R2/MinIO don't serve, so a custom endpoint without it 404s on every object.
 *
 * Credentials come from the standard AWS chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or an
 * instance role) — the SDK reads them itself, so they are never named here.
 */
export function getObjectStore(): ObjectStore {
  if (singleton) return singleton;
  if (process.env.STORAGE_PROVIDER === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket)
      throw new Error("S3_BUCKET is required when STORAGE_PROVIDER=s3");
    const endpoint = process.env.S3_ENDPOINT?.trim();
    const client = new S3Client({
      region: process.env.AWS_REGION,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    singleton = new S3ObjectStore(client, bucket);
  } else {
    singleton = new MemoryObjectStore();
  }
  return singleton;
}

/** Test seam: override/reset the cached store. */
export function __setObjectStore(store: ObjectStore | undefined): void {
  singleton = store;
}
