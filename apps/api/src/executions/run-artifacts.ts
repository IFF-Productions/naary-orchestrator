/**
 * Run ARTIFACTS — binary node outputs (today: textToSpeech audio, #689) that live in object storage
 * and are referenced from the run ctx as `{ __objectRef, contentType, bytes }`.
 *
 * Why not the claim-check path: `resolveCtxRefs` fetches + `JSON.parse`s every `{ __claimCheck }` in
 * the ctx on each run-detail read, which for audio would inline megabytes of base64 into the
 * response (or fetch-and-discard the object per poll). `__objectRef` is deliberately invisible to
 * that machinery; the bytes are streamed on demand through this route instead.
 *
 * SECURITY — the reference is read out of the RUN CTX, never from the request. The route takes only
 * (executionId, nodeId); accepting a client-supplied ref would be an arbitrary, cross-tenant object
 * read. That alone is not sufficient, though: a graph author can put ANY object into ctx (a `set`
 * node can emit a hand-written `{ __objectRef: "s3://bucket/tts/OTHER-TENANT/…" }`), so the
 * reference is additionally required to sit under this tenant's own `tts/<tenantId>/` prefix.
 * Both checks are pure and unit-tested below the API boundary.
 */

/** The `{ __objectRef }` shape a binary node output uses. */
export interface ObjectRefValue {
  __objectRef: string;
  contentType?: string;
  bytes?: number;
}

/** Content types this route is willing to serve. An arbitrary stored `contentType` must never
 *  reach a browser response header — that turns an object read into a stored-XSS/`text/html`
 *  sink. Anything unrecognized degrades to a non-rendering download. */
const SERVABLE_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "application/octet-stream",
]);

export function safeContentType(value: unknown): string {
  return typeof value === "string" && SERVABLE_CONTENT_TYPES.has(value)
    ? value
    : "application/octet-stream";
}

export function isObjectRefValue(v: unknown): v is ObjectRefValue {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ObjectRefValue).__objectRef === "string" &&
    (v as ObjectRefValue).__objectRef.length > 0
  );
}

/**
 * The object KEY inside a store reference: `mem://<key>` or `s3://<bucket>/<key>`. Returns null for
 * anything else (an unknown scheme, a bare string, a traversal attempt) — the caller then 404s.
 */
export function objectKeyFromRef(ref: string): string | null {
  // Reject traversal + absolute-ish escapes outright rather than trying to normalize them.
  if (ref.includes("..") || ref.includes("//./") || ref.includes("\\")) {
    return null;
  }
  const mem = /^mem:\/\/(.+)$/.exec(ref);
  if (mem) return mem[1];
  const s3 = /^s3:\/\/[^/]+\/(.+)$/.exec(ref);
  if (s3) return s3[1];
  return null;
}

/**
 * True when `ref` addresses an object this tenant owns — i.e. the key sits under the
 * `tts/<tenantId>/` prefix the textToSpeech activity writes. This is what stops a hand-authored
 * `__objectRef` in a graph from reading another tenant's audio.
 */
export function isTenantOwnedAudioRef(ref: string, tenantId: string): boolean {
  const key = objectKeyFromRef(ref);
  if (!key) return false;
  // tenantId is a uuid in practice; refuse anything with a path separator so a crafted tenant id
  // could never widen the prefix.
  if (!tenantId || tenantId.includes("/")) return false;
  return key.startsWith(`tts/${tenantId}/`);
}

/**
 * Pull the audio reference for `nodeId` out of a run ctx, or null when the node produced none.
 * Reads ONLY the documented `<nodeId>.output.audio` path — it does not go hunting for refs
 * anywhere in the ctx, so an unrelated node can't be coaxed into serving an object.
 */
export function audioRefFromCtx(
  ctx: Record<string, unknown> | undefined,
  nodeId: string,
): ObjectRefValue | null {
  if (!ctx || !Object.prototype.hasOwnProperty.call(ctx, nodeId)) return null;
  const node = ctx[nodeId];
  if (typeof node !== "object" || node === null) return null;
  const output = (node as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return null;
  const audio = (output as { audio?: unknown }).audio;
  return isObjectRefValue(audio) ? audio : null;
}

/** A safe download filename derived from ids + the stored content type (never from user text). */
export function audioFilename(nodeId: string, contentType: string): string {
  const ext =
    contentType === "audio/mpeg"
      ? "mp3"
      : contentType === "audio/ogg"
        ? "ogg"
        : contentType === "audio/wav"
          ? "wav"
          : contentType === "audio/aac"
            ? "aac"
            : contentType === "audio/flac"
              ? "flac"
              : "bin";
  const safeNode =
    nodeId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "node";
  return `${safeNode}.${ext}`;
}
