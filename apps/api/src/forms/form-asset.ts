/**
 * Pure (no NestJS / no I/O) image sniffing + limits for hosted-form logo uploads.
 * Unit-tested in test/form-asset.spec.ts.
 *
 * ## Why magic bytes and not Content-Type
 *
 * The upload is a raw body with a client-supplied `Content-Type`. That header is a *claim*: anyone
 * can POST a PHP script or an HTML document labelled `image/png`. Since the bytes are later served
 * back from **our own origin**, believing the claim would let a tenant host arbitrary content on our
 * domain — the classic upload-to-XSS path. So the stored `contentType` is derived from the bytes and
 * the header is used for nothing.
 *
 * ## Why SVG is refused
 *
 * SVG is XML that can carry `<script>`, and it has no magic number to sniff — "is this an SVG" can
 * only be answered by parsing, which means the decision rests on our parser agreeing with every
 * browser's. Served from our origin and opened directly (not via `<img>`, which doesn't run scripts),
 * a hostile SVG is stored XSS. It *can* be made safe — a `sandbox` CSP on the response, or a real
 * sanitizer — but that's a contract worth adding deliberately, with tests, rather than as a side
 * effect of shipping a logo picker. Raster formats have unambiguous signatures, so they're what this
 * accepts. See the follow-up issue.
 */

/**
 * Hard cap on a stored asset. A form logo is a header image (~200×60), so 512 KiB is already
 * generous — this is a bound on what an authenticated tenant can push into a Postgres row, not a
 * quality setting.
 */
export const MAX_ASSET_BYTES = 512 * 1024;

/** The image types we accept, keyed by the content type we will serve them back as. */
export type AssetContentType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Human list for error messages — kept next to the sniffer so the two can't disagree. */
export const ACCEPTED_IMAGE_LABEL = "PNG, JPEG, GIF or WebP";

/** Does `buf` start with these byte values? (`null` = any byte at that position.) */
function startsWith(buf: Buffer, sig: (number | null)[]): boolean {
  if (buf.length < sig.length) return false;
  return sig.every((b, i) => b === null || buf[i] === b);
}

/**
 * Identify an image from its leading bytes, or null if it isn't one of the accepted formats.
 *
 * Signatures are checked in full where a format has one, rather than on a one-byte prefix: a
 * loose check is how a polyglot file (valid image header, hostile payload after) gets in.
 */
export function sniffImageType(buf: Buffer): AssetContentType | null {
  // PNG: the 8-byte signature, including the CRLF/EOF bytes that detect text-mode corruption.
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // JPEG: SOI marker, then any APPn/other marker byte.
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a".
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  // WebP: RIFF container ("RIFF" ....size.... "WEBP"). Both halves are required — "RIFF" alone is
  // also WAV/AVI, and accepting those would mean serving audio as an image.
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return null;
}

export type AssetCheck =
  { ok: true; contentType: AssetContentType } | { ok: false; error: string };

/**
 * Validate uploaded bytes: non-empty, within the cap, and a recognised raster image.
 *
 * Order matters. The size check runs BEFORE sniffing so an oversized upload is reported as too large
 * rather than as an unrecognised format — the caller's actual mistake, and the difference between a
 * fixable error and a confusing one.
 */
export function checkAssetBytes(buf: Buffer): AssetCheck {
  if (buf.length === 0) return { ok: false, error: "Empty upload." };
  if (buf.length > MAX_ASSET_BYTES) {
    return {
      ok: false,
      error: `Image is larger than ${Math.floor(MAX_ASSET_BYTES / 1024)} KB.`,
    };
  }
  const contentType = sniffImageType(buf);
  if (!contentType) {
    return {
      ok: false,
      error:
        `Unsupported image. Use ${ACCEPTED_IMAGE_LABEL} — the file's actual contents are ` +
        "checked, not its name or content type. SVG is not accepted.",
    };
  }
  return { ok: true, contentType };
}

/** Cap on a served logo's alt text. Rendered as a text node, so this is a size bound, not escaping. */
export const MAX_LOGO_ALT = 120;
