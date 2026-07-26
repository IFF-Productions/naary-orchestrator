import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormsController } from "../src/forms/forms.controller";

/**
 * The PUBLIC asset route (`GET /forms/assets/:id`).
 *
 * Two things are being pinned. First the RESPONSE HARDENING: these bytes are tenant-supplied and
 * served from our own origin, so `nosniff` and a `default-src 'none'; sandbox` CSP are what stop
 * anything that slipped past the magic-byte check from executing in a browsing context. Losing either
 * header would silently turn an upload feature into a hosting-arbitrary-content feature, and nothing
 * else would fail.
 *
 * Second the CONDITIONAL path: a logo is fetched on every view of a public page, and a 304 must be
 * answered from the metadata row alone — never by downloading the object first.
 */
const SHA = "a".repeat(64);
const ETAG = `"${SHA}"`;

/** Minimal express-ish Response capturing headers/status/body. */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    body: undefined as Buffer | undefined,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end(chunk?: Buffer) {
      this.body = chunk;
      return this;
    },
  };
}

function makeController(
  meta: { contentType: string; sha256: string } | null,
  bytes: Buffer | null = Buffer.from([1, 2, 3]),
) {
  const assets = {
    getMeta: vi.fn().mockResolvedValue(meta),
    get: vi
      .fn()
      .mockResolvedValue(
        bytes && meta
          ? { contentType: meta.contentType, bytes, sha256: meta.sha256 }
          : null,
      ),
  };
  const controller = new FormsController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    assets as never,
  );
  return { controller, assets };
}

/** Call the route with the given `if-none-match` header value (omit for none). */
async function fetchAsset(
  controller: FormsController,
  ifNoneMatch?: string | string[],
) {
  const res = makeRes();
  const req = {
    headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
  };
  await controller.asset("asset-1", req as never, res as never);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe("serving an asset", () => {
  it("returns the bytes with the sniffed content type", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const res = await fetchAsset(controller);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body?.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  /** The hardening headers — each is why a hostile upload can't become executable content. */
  it("sets nosniff, a sandbox CSP, inline disposition and an immutable cache", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const res = await fetchAsset(controller);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox",
    );
    // No filename echoed back — the stored bytes carry no author-controlled name.
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.etag).toBe(ETAG);
  });

  it("404s an unknown id without reading object storage", async () => {
    const { controller, assets } = makeController(null);
    await expect(fetchAsset(controller)).rejects.toThrow(NotFoundException);
    expect(assets.get).not.toHaveBeenCalled();
  });

  /** A vanished object (bucket lifecycle, restore skew) must 404, never 500 the page it decorates. */
  it("404s when the row exists but the object is gone", async () => {
    const { controller } = makeController(
      { contentType: "image/png", sha256: SHA },
      null,
    );
    await expect(fetchAsset(controller)).rejects.toThrow(NotFoundException);
  });
});

describe("conditional requests", () => {
  /**
   * The whole point of `getMeta`: a matching ETag is answered WITHOUT the S3 GetObject. If `get` were
   * called here, the ETag would be saving bandwidth only — the inaccurate claim a reviewer caught in
   * the first version of this route.
   */
  it("returns 304 without fetching the object when the ETag matches", async () => {
    const { controller, assets } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const res = await fetchAsset(controller, ETAG);
    expect(res.statusCode).toBe(304);
    expect(res.body).toBeUndefined();
    expect(assets.get).not.toHaveBeenCalled();
    // Caching headers still ride along on a 304, or the client forgets what it knew.
    expect(res.headers.etag).toBe(ETAG);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("serves the bytes when the ETag does not match", async () => {
    const { controller, assets } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const res = await fetchAsset(controller, '"someotherhash"');
    expect(res.statusCode).toBe(200);
    expect(assets.get).toHaveBeenCalled();
  });

  /** A client may send several validators, and a `W/` prefix for a weak one. */
  it("matches within a comma-separated list", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const res = await fetchAsset(controller, `"other", ${ETAG}, "third"`);
    expect(res.statusCode).toBe(304);
  });

  it("matches a weak validator prefix", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    expect((await fetchAsset(controller, `W/${ETAG}`)).statusCode).toBe(304);
  });

  it("treats `*` as a match", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    expect((await fetchAsset(controller, "*")).statusCode).toBe(304);
  });

  it("serves normally when no validator is sent", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    expect((await fetchAsset(controller)).statusCode).toBe(200);
  });

  /** A different asset's ETag must not produce a 304 — that would serve a stale cached image. */
  it("does not 304 on a near-miss hash", async () => {
    const { controller } = makeController({
      contentType: "image/png",
      sha256: SHA,
    });
    const nearMiss = `"${"a".repeat(63)}b"`;
    expect((await fetchAsset(controller, nearMiss)).statusCode).toBe(200);
  });
});
