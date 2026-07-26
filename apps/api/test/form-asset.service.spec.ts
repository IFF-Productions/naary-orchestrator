import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ formAsset: { findUnique, findFirst, create } }),
}));

import { MemoryObjectStore, type ObjectStore } from "@naary/storage";
import {
  FormAssetService,
  readBodyCapped,
} from "../src/forms/form-asset.service";
import { MAX_ASSET_BYTES } from "../src/forms/form-asset";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]);

/** A durable stand-in for S3 — anything that ISN'T MemoryObjectStore passes the durability guard. */
function fakeS3(): ObjectStore & { puts: [string, Buffer | string][] } {
  const objects = new Map<string, Buffer>();
  const puts: [string, Buffer | string][] = [];
  return {
    puts,
    async put(key, data) {
      puts.push([key, data]);
      objects.set(key, Buffer.from(data));
      return `s3://test-bucket/${key}`;
    },
    async get(ref) {
      const key = ref.replace("s3://test-bucket/", "");
      const value = objects.get(key);
      if (!value) throw new Error(`missing: ${ref}`);
      return value;
    },
  };
}

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
  create.mockReset();
});

describe("store", () => {
  it("puts the bytes in object storage and records the ref", async () => {
    const objects = fakeS3();
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "asset-1" });

    const out = await new FormAssetService(objects).store("t-1", "e-1", PNG);

    expect(out).toEqual({ assetId: "asset-1", contentType: "image/png" });
    // Keyed by tenant + env + kind + content hash: tenant-partitioned for lifecycle rules, and the
    // hash makes a repeat write idempotent.
    expect(objects.puts).toHaveLength(1);
    expect(objects.puts[0][0]).toMatch(
      /^form-assets\/t-1\/e-1\/logo\/[0-9a-f]{64}$/,
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.objectRef).toBe(`s3://test-bucket/${objects.puts[0][0]}`);
    expect(data.byteSize).toBe(PNG.length);
    // The content type is SNIFFED, never taken from a request header.
    expect(data.contentType).toBe("image/png");
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Content-addressed dedupe. Beyond saving space, this is what makes the public serve route safe to
   * cache immutably: an id's bytes can never change, because different bytes are a different id.
   */
  it("reuses the existing row for identical bytes instead of duplicating", async () => {
    const objects = fakeS3();
    findUnique.mockResolvedValue({ id: "asset-existing" });

    const out = await new FormAssetService(objects).store("t-1", "e-1", PNG);

    expect(out.assetId).toBe("asset-existing");
    expect(create).not.toHaveBeenCalled();
    // And it doesn't re-upload — the object is already there under the same content-hash key.
    expect(objects.puts).toHaveLength(0);
  });

  it("rejects a non-image before touching storage or the database", async () => {
    const objects = fakeS3();
    await expect(
      new FormAssetService(objects).store(
        "t-1",
        "e-1",
        Buffer.from("<svg><script/></svg>"),
      ),
    ).rejects.toThrow(/Unsupported image/i);
    expect(objects.puts).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  /**
   * The most important test here. `getObjectStore()` falls back to MemoryObjectStore when
   * STORAGE_PROVIDER is unset, which for a logo means: stored in ONE api process's heap, gone on the
   * next docker-rollout, invisible to every other replica. A customer-facing form would show a broken
   * image intermittently with nothing logged. A loud 503 beats that silent half-failure.
   */
  it("REFUSES to store when object storage is the in-memory fallback", async () => {
    const service = new FormAssetService(new MemoryObjectStore());
    await expect(service.store("t-1", "e-1", PNG)).rejects.toThrow(
      /STORAGE_PROVIDER/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("says which env vars to set, so the failure is actionable", async () => {
    const service = new FormAssetService(new MemoryObjectStore());
    await expect(service.store("t-1", "e-1", PNG)).rejects.toThrow(/S3_BUCKET/);
  });
});

describe("get", () => {
  it("returns the bytes and the hash for a known asset", async () => {
    const objects = fakeS3();
    const ref = await objects.put("form-assets/t-1/e-1/logo/abc", PNG);
    findUnique.mockResolvedValue({
      contentType: "image/png",
      objectRef: ref,
      sha256: "abc",
    });

    const out = await new FormAssetService(objects).get("asset-1");
    expect(out?.contentType).toBe("image/png");
    expect(out?.bytes.equals(PNG)).toBe(true);
    expect(out?.sha256).toBe("abc");
  });

  it("returns null for an unknown id", async () => {
    findUnique.mockResolvedValue(null);
    expect(await new FormAssetService(fakeS3()).get("nope")).toBeNull();
  });

  /**
   * A row whose object has vanished (bucket lifecycle rule, database restored ahead of its bucket)
   * must read as "no image", not as a 500. A missing logo must never take down the form it decorates.
   */
  it("returns null — not a throw — when the object is missing from storage", async () => {
    findUnique.mockResolvedValue({
      contentType: "image/png",
      objectRef: "s3://test-bucket/form-assets/gone",
      sha256: "abc",
    });
    expect(await new FormAssetService(fakeS3()).get("asset-1")).toBeNull();
  });
});

describe("ownedBy (cross-tenant guard)", () => {
  it("scopes the lookup to the tenant AND environment", async () => {
    findFirst.mockResolvedValue({ id: "asset-1" });
    const ok = await new FormAssetService(fakeS3()).ownedBy(
      "asset-1",
      "t-1",
      "e-1",
    );
    expect(ok).toBe(true);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: "asset-1",
      tenantId: "t-1",
      environmentId: "e-1",
    });
  });

  /** Without this, a tenant could paste an id learned from another workspace's public form. */
  it("is false for another tenant's asset", async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await new FormAssetService(fakeS3()).ownedBy("asset-1", "t-2", "e-1"),
    ).toBe(false);
  });
});

describe("readBodyCapped", () => {
  /** Build a fake request stream that emits `chunks` then ends. */
  function reqOf(...chunks: Buffer[]): IncomingMessage {
    const stream = new PassThrough() as unknown as IncomingMessage;
    process.nextTick(() => {
      for (const c of chunks) (stream as unknown as PassThrough).write(c);
      (stream as unknown as PassThrough).end();
    });
    return stream;
  }

  it("concatenates the body", async () => {
    const body = await readBodyCapped(
      reqOf(Buffer.from("abc"), Buffer.from("def")),
    );
    expect(body.toString()).toBe("abcdef");
  });

  it("accepts a body exactly at the limit", async () => {
    const body = await readBodyCapped(reqOf(Buffer.alloc(10, 1)), 10);
    expect(body.length).toBe(10);
  });

  /**
   * The DoS bound. `express.json()` is content-type gated and skips an `image/png` body entirely, so
   * nothing upstream has bounded this stream — without a cap here an authenticated caller could stream
   * unbounded data into the api's heap.
   */
  it("rejects a body one byte over the limit", async () => {
    await expect(
      readBodyCapped(reqOf(Buffer.alloc(11, 1)), 10),
    ).rejects.toThrow(/larger than/i);
  });

  it("rejects as soon as the running total exceeds the limit, mid-stream", async () => {
    await expect(
      readBodyCapped(
        reqOf(Buffer.alloc(6, 1), Buffer.alloc(6, 1), Buffer.alloc(6, 1)),
        10,
      ),
    ).rejects.toThrow(/larger than/i);
  });

  /** Destroying rather than draining: a caller must not get to keep streaming after we refuse. */
  it("destroys the request on overflow", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    const promise = readBodyCapped(req, 4);
    stream.write(Buffer.alloc(8, 1));
    await expect(promise).rejects.toThrow(/larger than/i);
    expect(stream.destroyed).toBe(true);
  });

  it("defaults to the asset cap", async () => {
    await expect(
      readBodyCapped(reqOf(Buffer.alloc(MAX_ASSET_BYTES + 1))),
    ).rejects.toThrow(/larger than/i);
  });

  it("surfaces a stream error as a 400 rather than hanging", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    const promise = readBodyCapped(req);
    stream.emit("error", new Error("socket reset"));
    await expect(promise).rejects.toThrow(/Upload failed/i);
  });
});
