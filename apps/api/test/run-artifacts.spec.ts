// Run AUDIO artifacts (#689) — the pure guards behind GET /executions/:id/nodes/:nodeId/audio.
//
// The route takes only (executionId, nodeId); the object reference is read out of the run ctx. That
// alone is NOT enough, because a graph author can write any `__objectRef` into ctx (a `set` node
// can emit one), so the reference must additionally prove it sits under this tenant's storage
// prefix. These tests pin exactly that, plus the content-type allow-list.
import { describe, expect, it } from "vitest";
import {
  audioFilename,
  audioRefFromCtx,
  isObjectRefValue,
  isTenantOwnedAudioRef,
  objectKeyFromRef,
  safeContentType,
} from "../src/executions/run-artifacts";

const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const audioOutput = (ref: string) => ({
  tts: {
    status: "ok",
    output: {
      audio: { __objectRef: ref, contentType: "audio/mpeg", bytes: 4096 },
      format: "mp3",
    },
  },
});

describe("audioRefFromCtx", () => {
  it("reads ONLY <nodeId>.output.audio", () => {
    const ref = `mem://tts/${TENANT}/wf-1/tts.mp3`;
    expect(audioRefFromCtx(audioOutput(ref), "tts")?.__objectRef).toBe(ref);
    // A ref hidden somewhere else in the node's output is NOT found — the reader doesn't go
    // hunting, so an unrelated node can't be coaxed into serving an object.
    expect(
      audioRefFromCtx(
        { tts: { output: { nested: { audio: { __objectRef: ref } } } } },
        "tts",
      ),
    ).toBeNull();
  });

  it("returns null for a missing node, a non-object node, or a missing audio", () => {
    expect(audioRefFromCtx({}, "tts")).toBeNull();
    expect(audioRefFromCtx(undefined, "tts")).toBeNull();
    expect(audioRefFromCtx({ tts: "nope" }, "tts")).toBeNull();
    expect(audioRefFromCtx({ tts: { output: {} } }, "tts")).toBeNull();
    expect(
      audioRefFromCtx({ tts: { output: { audio: 42 } } }, "tts"),
    ).toBeNull();
  });

  it("is not fooled by prototype-chain keys", () => {
    // A ctx parsed from a hostile graph could be probed with nodeId "toString"/"constructor";
    // the own-property check must not resolve those to a function on Object.prototype.
    for (const nodeId of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(audioRefFromCtx({}, nodeId), nodeId).toBeNull();
    }
  });

  it("requires a non-empty string __objectRef", () => {
    expect(isObjectRefValue({ __objectRef: "mem://x" })).toBe(true);
    expect(isObjectRefValue({ __objectRef: "" })).toBe(false);
    expect(isObjectRefValue({ __objectRef: 42 })).toBe(false);
    expect(isObjectRefValue(null)).toBe(false);
    // A CLAIM check is a different mechanism and must not be served by this route.
    expect(isObjectRefValue({ __claimCheck: "mem://x", bytes: 1 })).toBe(false);
  });
});

describe("objectKeyFromRef", () => {
  it("extracts the key from the supported schemes", () => {
    expect(objectKeyFromRef("mem://tts/t1/wf/n.mp3")).toBe("tts/t1/wf/n.mp3");
    expect(objectKeyFromRef("s3://my-bucket/tts/t1/wf/n.mp3")).toBe(
      "tts/t1/wf/n.mp3",
    );
  });

  it("rejects traversal, backslashes, and unknown schemes", () => {
    for (const bad of [
      "mem://tts/t1/../../other/secret.mp3",
      "s3://bucket/tts/t1/..%2fx",
      "mem://tts\\t1\\n.mp3",
      "https://evil.example.com/x.mp3",
      "file:///etc/passwd",
      "tts/t1/wf/n.mp3", // no scheme
      "",
    ]) {
      expect(objectKeyFromRef(bad), bad).toBeNull();
    }
  });
});

describe("isTenantOwnedAudioRef — the cross-tenant guard", () => {
  it("accepts this tenant's own audio prefix, in both store schemes", () => {
    expect(
      isTenantOwnedAudioRef(`mem://tts/${TENANT}/wf-1/tts.mp3`, TENANT),
    ).toBe(true);
    expect(
      isTenantOwnedAudioRef(`s3://bucket/tts/${TENANT}/wf-1/tts.mp3`, TENANT),
    ).toBe(true);
  });

  it("REFUSES another tenant's object (the graph-authored __objectRef attack)", () => {
    // What a malicious `set` node would emit to try to read someone else's audio.
    expect(
      isTenantOwnedAudioRef(`mem://tts/${OTHER}/wf-9/tts.mp3`, TENANT),
    ).toBe(false);
    expect(
      isTenantOwnedAudioRef(`s3://bucket/tts/${OTHER}/wf-9/tts.mp3`, TENANT),
    ).toBe(false);
  });

  it("REFUSES a prefix-confusion neighbour and any non-tts key", () => {
    // `tts/<tenant>` must not match `tts/<tenant>-evil/…`.
    expect(
      isTenantOwnedAudioRef(`mem://tts/${TENANT}-evil/wf/tts.mp3`, TENANT),
    ).toBe(false);
    // Other offload prefixes (codeagent diffs, http bodies) are not audio and are not served here.
    expect(
      isTenantOwnedAudioRef(`mem://codeagent-diff/${TENANT}/x.json`, TENANT),
    ).toBe(false);
    expect(isTenantOwnedAudioRef(`mem://http/${TENANT}/x.json`, TENANT)).toBe(
      false,
    );
  });

  it("REFUSES a crafted tenant id that would widen the prefix", () => {
    expect(isTenantOwnedAudioRef("mem://tts/a/b/wf/n.mp3", "a/b")).toBe(false);
    expect(isTenantOwnedAudioRef("mem://tts//wf/n.mp3", "")).toBe(false);
  });
});

describe("safeContentType — an object read must not become an HTML sink", () => {
  it("passes the audio types through", () => {
    for (const ct of [
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/aac",
      "audio/flac",
      "application/octet-stream",
    ]) {
      expect(safeContentType(ct)).toBe(ct);
    }
  });

  it("collapses anything else to a non-rendering download", () => {
    for (const ct of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      'audio/mpeg";x=<script>',
      "",
      undefined,
      42,
    ]) {
      expect(safeContentType(ct), String(ct)).toBe("application/octet-stream");
    }
  });
});

describe("audioFilename", () => {
  it("derives the extension from the content type", () => {
    expect(audioFilename("tts", "audio/mpeg")).toBe("tts.mp3");
    expect(audioFilename("tts", "audio/wav")).toBe("tts.wav");
    expect(audioFilename("tts", "application/octet-stream")).toBe("tts.bin");
  });

  it("sanitizes the node id so it can't break out of the header", () => {
    // A header-injection / path-escape attempt in a node id must not reach content-disposition.
    expect(audioFilename('a"; filename="evil.html', "audio/mpeg")).toBe(
      "a___filename__evil.html.mp3",
    );
    expect(audioFilename("../../etc/passwd", "audio/mpeg")).toBe(
      ".._.._etc_passwd.mp3",
    );
    expect(audioFilename("", "audio/mpeg")).toBe("node.mp3");
    expect(audioFilename("x".repeat(200), "audio/mpeg")).toHaveLength(
      64 + ".mp3".length,
    );
  });
});
