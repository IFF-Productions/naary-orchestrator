import { describe, expect, it } from "vitest";
import {
  audioFileName,
  extractAudioRef,
  nodeAudioPath,
} from "../src/screens/app/run-detail/NodeAudio";

/**
 * textToSpeech run-view helpers (#689). `extractAudioRef` is the ONLY thing that decides whether the
 * run view offers a player, and `nodeAudioPath` builds the authenticated API URL it fetches — both
 * pure, so they're unit-tested here (web specs are node-environment; the component itself isn't).
 */
describe("extractAudioRef", () => {
  const ok = {
    status: "ok",
    output: {
      audio: {
        __objectRef: "tenants/t1/runs/r1/n1.mp3",
        contentType: "audio/mpeg",
        bytes: 2048,
      },
      format: "mp3",
      voice: "alloy",
    },
    costUsd: 0.0003,
  };

  it("pulls the reference out of a real textToSpeech output", () => {
    expect(extractAudioRef(ok)).toEqual({
      __objectRef: "tenants/t1/runs/r1/n1.mp3",
      contentType: "audio/mpeg",
      bytes: 2048,
    });
  });

  it("returns undefined for every other node shape (no player, no crash)", () => {
    expect(extractAudioRef(undefined)).toBeUndefined();
    expect(extractAudioRef(null)).toBeUndefined();
    expect(extractAudioRef("mp3")).toBeUndefined();
    expect(extractAudioRef([{ a: 1 }])).toBeUndefined();
    // An agent-style output — has `output`, but no `audio`.
    expect(
      extractAudioRef({ status: "ok", output: { text: "hi" } }),
    ).toBeUndefined();
    // codeAgent's claim-check shape must NOT be mistaken for audio.
    expect(
      extractAudioRef({ output: { trace: { __claimCheck: "k", bytes: 10 } } }),
    ).toBeUndefined();
  });

  it("rejects a partial/malformed audio object rather than rendering a broken player", () => {
    const bad = [
      { audio: {} },
      { audio: { __objectRef: "", contentType: "audio/mpeg", bytes: 1 } },
      { audio: { __objectRef: "k", contentType: "", bytes: 1 } },
      { audio: { __objectRef: "k", contentType: "audio/mpeg" } },
      { audio: { __objectRef: "k", contentType: "audio/mpeg", bytes: "2048" } },
      {
        audio: {
          __objectRef: "k",
          contentType: "audio/mpeg",
          bytes: Number.NaN,
        },
      },
    ];
    for (const output of bad)
      expect(extractAudioRef({ output })).toBeUndefined();
  });
});

describe("nodeAudioPath", () => {
  it("builds the executions audio route", () => {
    expect(nodeAudioPath("run-1", "tts")).toBe(
      "/executions/run-1/nodes/tts/audio",
    );
  });

  it("encodes BOTH segments — a node id is user-authored and could change the route", () => {
    expect(nodeAudioPath("run/1", "a b/../c?x=1")).toBe(
      "/executions/run%2F1/nodes/a%20b%2F..%2Fc%3Fx%3D1/audio",
    );
  });
});

describe("audioFileName", () => {
  it("uses the known extension for the content type", () => {
    expect(audioFileName("tts", "audio/mpeg")).toBe("tts.mp3");
    expect(audioFileName("tts", "audio/wav; charset=binary")).toBe("tts.wav");
  });

  it("omits the extension for an unknown type and sanitizes the node id", () => {
    expect(audioFileName("tts", "application/octet-stream")).toBe("tts");
    expect(audioFileName("my node/1", "audio/mpeg")).toBe("my-node-1.mp3");
  });
});
