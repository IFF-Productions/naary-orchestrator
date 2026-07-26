import { describe, expect, it } from "vitest";
import {
  MAX_ASSET_BYTES,
  checkAssetBytes,
  sniffImageType,
} from "../src/forms/form-asset";

/**
 * Image identification for hosted-form logo uploads.
 *
 * This is the security boundary of the feature, not a formatting nicety. The bytes are served back
 * from **our own origin**, so if a hostile file is accepted as an image, it's hosted content on our
 * domain — the classic upload-to-XSS path. The request's `Content-Type` is a claim anyone can forge,
 * so identification has to come from the bytes.
 */

/** Minimal valid headers for each accepted format, padded so length checks are realistic. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 1),
]);
const GIF87 = Buffer.concat([Buffer.from("GIF87a"), Buffer.alloc(32, 1)]);
const GIF89 = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]), // little-endian size
  Buffer.from("WEBP"),
  Buffer.alloc(32, 1),
]);

describe("sniffImageType identifies the accepted raster formats", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["GIF87a", GIF87, "image/gif"],
    ["GIF89a", GIF89, "image/gif"],
    ["WebP", WEBP, "image/webp"],
  ])("%s", (_label, buf, expected) => {
    expect(sniffImageType(buf as Buffer)).toBe(expected);
  });
});

describe("sniffImageType rejects everything else", () => {
  /**
   * The hostile set. Each of these is something a caller might POST labelled `image/png`, and each
   * would be a served-from-our-origin problem if accepted:
   *  - HTML/SVG execute in a browsing context;
   *  - a PHP/script file matters if anything downstream ever interprets by extension;
   *  - `RIFF` without `WEBP` is a WAV/AVI — accepting it would serve audio as an image.
   */
  it.each([
    ["HTML", Buffer.from("<!doctype html><script>alert(1)</script>")],
    [
      "SVG",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    ],
    ["SVG with XML prolog", Buffer.from('<?xml version="1.0"?><svg></svg>')],
    ["PHP", Buffer.from("<?php system($_GET['c']); ?>")],
    ["plain text", Buffer.from("just some text")],
    ["empty", Buffer.alloc(0)],
    [
      "RIFF but not WEBP (a WAV)",
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x24, 0, 0, 0]),
        Buffer.from("WAVE"),
      ]),
    ],
    ["PDF", Buffer.from("%PDF-1.7\n")],
    ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ])("%s", (_label, buf) => {
    expect(sniffImageType(buf as Buffer)).toBeNull();
  });

  /**
   * A truncated signature must not pass on a prefix match. This is the polyglot concern: a file whose
   * first few bytes look like PNG but whose signature is incomplete.
   */
  it("rejects a truncated PNG signature", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });

  /**
   * PNG's signature includes CRLF/EOF bytes specifically so text-mode mangling is detectable — a
   * one-byte prefix check would accept a corrupted file the decoder then rejects.
   */
  it("rejects a PNG whose signature bytes were mangled", () => {
    const mangled = Buffer.from(PNG);
    // Index 4 is the 0x0d of the signature's CRLF; collapsing it to 0x0a is exactly what a
    // text-mode transfer does, and is why the signature carries those bytes in the first place.
    expect(mangled[4]).toBe(0x0d);
    mangled[4] = 0x0a;
    expect(sniffImageType(mangled)).toBeNull();
  });

  /** WebP needs BOTH halves of the container; "RIFF" alone is ambiguous. */
  it("rejects a WebP missing its WEBP fourcc", () => {
    const bad = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x24, 0, 0, 0]),
      Buffer.from("XXXX"),
      Buffer.alloc(16, 1),
    ]);
    expect(sniffImageType(bad)).toBeNull();
  });

  /** A hostile payload appended AFTER a valid header is still served as the sniffed type, with
   *  nosniff + a sandbox CSP on the response — this pins that we identify by the header, which is
   *  what those response headers are there to backstop. */
  it("identifies a polyglot by its real header, not its payload", () => {
    const polyglot = Buffer.concat([
      PNG,
      Buffer.from("<script>alert(1)</script>"),
    ]);
    expect(sniffImageType(polyglot)).toBe("image/png");
  });
});

describe("checkAssetBytes", () => {
  it("accepts a valid image", () => {
    expect(checkAssetBytes(PNG)).toEqual({
      ok: true,
      contentType: "image/png",
    });
  });

  it("rejects an empty upload with a distinct message", () => {
    const result = checkAssetBytes(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/empty/i);
  });

  it("accepts exactly the cap", () => {
    const atCap = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_ASSET_BYTES - PNG.length),
    ]);
    expect(atCap.length).toBe(MAX_ASSET_BYTES);
    expect(checkAssetBytes(atCap).ok).toBe(true);
  });

  it("rejects one byte over the cap", () => {
    const overCap = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_ASSET_BYTES - PNG.length + 1),
    ]);
    expect(checkAssetBytes(overCap).ok).toBe(false);
  });

  /**
   * Order matters: an oversized upload must be reported as TOO LARGE, not as an unrecognised format.
   * The size is the caller's actual mistake, and conflating the two turns a fixable error into a
   * confusing one ("but it IS a PNG").
   */
  it("reports an oversized VALID image as too large, not as unsupported", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)]);
    const result = checkAssetBytes(huge);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/larger than/i);
    expect(result.ok === false && result.error).not.toMatch(/unsupported/i);
  });

  it("names the accepted formats and says SVG is refused, so the fix is obvious", () => {
    const result = checkAssetBytes(Buffer.from("<svg></svg>"));
    expect(result.ok).toBe(false);
    const error = result.ok === false ? result.error : "";
    expect(error).toMatch(/PNG/);
    expect(error).toMatch(/SVG is not accepted/i);
    // And it says the CONTENTS were checked — otherwise a user renames the file and retries.
    expect(error).toMatch(/actual contents/i);
  });
});
