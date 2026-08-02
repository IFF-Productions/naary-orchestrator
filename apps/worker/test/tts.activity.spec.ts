// textToSpeech activity (#689). No live provider call is made anywhere in this file — the network
// is mocked at the `__ttsDeps.fetch` seam and the object store is an in-memory one, so every
// assertion below is about the ACTIVITY's contract: audio never rides the payload, usage is always
// non-zero and character-denominated, 401/429 don't burn retries, and the synthesized text never
// reaches a log or the ledger.
import { ApplicationFailure } from "@temporalio/activity";
import { MissingCredentialError } from "@naary/secrets";
import { isClaimCheck, MemoryObjectStore } from "@naary/storage";
import { computeCost } from "@naary/usage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentTypeFor, resolveTtsDriver } from "../src/temporal/tts-drivers";
import { __ttsDeps, callTextToSpeech } from "../src/temporal/activities";
// Constants come from the module itself (the activities barrel re-exports only the callable +
// its seam), so the caps under test are the real ones rather than a copy.
import { MAX_TTS_INPUT_CHARS } from "../src/temporal/activities/tts";

const META = { tenantId: "t1", executionId: "wf-1", nodeId: "tts1" };
const TEXT = "Your order has shipped and will arrive on Thursday.";

const getDecryptedKey = vi.fn();
const recordUsage = vi.fn();
const fetchMock = vi.fn();
let store: MemoryObjectStore;

/** A successful provider response carrying raw audio bytes (NOT JSON — the whole reason this node
 *  can't ride the JSON integration catalog). */
function audioRes(
  bytes = 4096,
  status = 200,
  headers?: Record<string, string>,
) {
  const body = Buffer.alloc(bytes, 7);
  return {
    ok: status < 400,
    status,
    headers: new Headers({
      "content-type": "audio/mpeg",
      "content-length": String(bytes),
      ...(headers ?? {}),
    }),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    // If the activity ever reads the body as text on an error path, this would surface it — the
    // tests below assert it is NOT called on a failure (a provider error body can echo the input).
    text: async () => {
      throw new Error("the activity must not read the response body as text");
    },
  } as unknown as Response;
}

/** A provider ERROR response. `text` throws for the same reason as above. */
function errRes(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => {
      throw new Error("the activity must not read an error body");
    },
  } as unknown as Response;
}

beforeEach(() => {
  store = new MemoryObjectStore();
  getDecryptedKey.mockReset().mockResolvedValue("sk-openai-secret-xyz");
  recordUsage.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue(audioRes());
  __ttsDeps.getCredentials = (() => ({ getDecryptedKey })) as never;
  __ttsDeps.getDefaultEnvId = (() => Promise.resolve("e1")) as never;
  __ttsDeps.recordUsage = recordUsage as never;
  __ttsDeps.getStore = (() => store) as never;
  __ttsDeps.fetch = fetchMock as never;
});

/** Await a call that MUST fail, returning its ApplicationFailure. Fails the test if it resolves —
 *  so a silently-successful call can never be mistaken for the error case under test. */
async function expectFailure(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApplicationFailure);
    return e as ApplicationFailure;
  }
  throw new Error("expected the activity to fail, but it resolved");
}

describe("openai tts driver (pure)", () => {
  const d = resolveTtsDriver(undefined);

  it("defaults to openai and builds a POST to /v1/audio/speech with the key in the header only", () => {
    expect(d.provider).toBe("openai");
    expect(d.credentialProvider).toBe("openai"); // reuses the tenant's existing OpenAI slot
    const req = d.buildRequest(
      { text: "hi", format: "wav", speed: 1.5 },
      "KEY",
    );
    expect(req.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer KEY");
    // The key is ONLY in the header — never in the URL or the body.
    expect(req.url).not.toContain("KEY");
    expect(req.body).not.toContain("KEY");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "tts-1",
      voice: "alloy",
      input: "hi",
      response_format: "wav",
      speed: 1.5,
    });
  });

  it("omits speed when unset and maps formats to content types", () => {
    expect(
      JSON.parse(d.buildRequest({ text: "hi" }, "K").body),
    ).not.toHaveProperty("speed");
    expect(contentTypeFor("mp3")).toBe("audio/mpeg");
    expect(contentTypeFor("wav")).toBe("audio/wav");
    expect(contentTypeFor(undefined)).toBe("audio/mpeg"); // default format
  });

  it("rejects an unknown provider cleanly instead of crashing", () => {
    expect(() => resolveTtsDriver("elevenlabs")).toThrow(/unknown provider/i);
  });
});

describe("callTextToSpeech — claim-check / payload safety", () => {
  it("returns a reference + metadata, with NO audio bytes in the payload", async () => {
    const out = await callTextToSpeech({ text: TEXT }, null, META);

    // The reference, not the blob.
    expect(out.output.audio.__objectRef).toMatch(
      /^mem:\/\/tts\/t1\/wf-1\/tts1\.mp3$/,
    );
    expect(out.output.audio.contentType).toBe("audio/mpeg");
    expect(out.output.audio.bytes).toBe(4096);
    expect(out.output.bytes).toBe(4096);
    expect(out.output.format).toBe("mp3");
    expect(out.output.voice).toBe("alloy");
    expect(out.output.provider).toBe("openai");
    expect(out.output.characters).toBe(TEXT.length);
    // OpenAI reports no duration — we never fabricate one from the byte count.
    expect(out.output.durationSeconds).toBeUndefined();

    // THE assertion that matters: the whole serialized payload is tiny and contains no audio.
    const serialized = JSON.stringify(out);
    expect(Buffer.byteLength(serialized)).toBeLessThan(1000);
    // The audio was 4096 bytes of 0x07; no encoding of it may appear in the payload.
    expect(serialized).not.toContain(Buffer.alloc(32, 7).toString("base64"));
    expect(serialized).not.toContain(Buffer.alloc(32, 7).toString("hex"));
    expect(serialized).not.toContain(Buffer.alloc(32, 7).toString("latin1"));
    // …and no field anywhere in the payload is a buffer/array of numbers.
    expect(serialized).not.toContain('"type":"Buffer"');

    // The bytes ARE in the store, addressable by the returned reference.
    const stored = await store.get(out.output.audio.__objectRef);
    expect(stored.byteLength).toBe(4096);
    expect(stored.every((b) => b === 7)).toBe(true);
  });

  it("does NOT use the auto-resolved __claimCheck shape (the API would inline the audio)", async () => {
    const out = await callTextToSpeech({ text: TEXT }, null, META);
    // `isClaimCheck` is what the API's run-detail read (resolveCtxRefs) scans for — the audio ref
    // must be invisible to it, or every run-detail poll would fetch (and try to JSON.parse) the
    // whole audio object. Guards against someone "fixing" this back to a claim check.
    expect(isClaimCheck(out.output.audio)).toBe(false);
    expect(out.output.audio).not.toHaveProperty("__claimCheck");
  });

  it("derives the object key from execution+node, so a retry overwrites instead of orphaning", async () => {
    const a = await callTextToSpeech({ text: TEXT }, null, META);
    const b = await callTextToSpeech({ text: TEXT }, null, META);
    expect(b.output.audio.__objectRef).toBe(a.output.audio.__objectRef);
  });

  it("honors the format in both the request and the stored object key", async () => {
    const out = await callTextToSpeech(
      { text: TEXT, format: "wav" },
      null,
      META,
    );
    expect(out.output.audio.__objectRef).toMatch(/\.wav$/);
    expect(out.output.audio.contentType).toBe("audio/wav");
  });
});

describe("callTextToSpeech — BYOK credential handling (Tier-1 rule 4)", () => {
  it("fetches the key IN-ACTIVITY for the run's env and never returns it", async () => {
    const out = await callTextToSpeech({ text: TEXT }, null, {
      ...META,
      environmentId: "env-uat",
    });
    expect(getDecryptedKey).toHaveBeenCalledWith("t1", "env-uat", "openai");
    expect(JSON.stringify(out)).not.toContain("sk-openai-secret-xyz");
  });

  it("falls back to the tenant default env for a pre-env run", async () => {
    await callTextToSpeech({ text: TEXT }, null, META);
    expect(getDecryptedKey).toHaveBeenCalledWith("t1", "e1", "openai");
  });

  it("sends the key as a header on the provider call only", async () => {
    await callTextToSpeech({ text: TEXT }, null, META);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-openai-secret-xyz",
    );
  });

  it("maps a missing credential to a non-retryable AUTH failure", async () => {
    getDecryptedKey.mockRejectedValue(
      new MissingCredentialError("t1", "openai"),
    );
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("AUTH");
    expect(recordUsage).not.toHaveBeenCalled(); // nothing was synthesized → nothing to bill
  });
});

describe("callTextToSpeech — billing (Tier-1 rule 6: never zero)", () => {
  it("records CHARACTER-denominated usage against the openai-tts price table", async () => {
    const out = await callTextToSpeech({ text: TEXT }, null, META);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    const rec = recordUsage.mock.calls[0][0] as {
      provider: string;
      model: string;
      nodeType: string;
      durationMs: number;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    // One synthetic token per character — the documented mapping onto the token-shaped ledger.
    expect(rec.usage.inputTokens).toBe(TEXT.length);
    expect(rec.usage.outputTokens).toBe(0);
    expect(rec.usage.totalTokens).toBe(TEXT.length);
    expect(rec.usage.inputTokens).toBeGreaterThan(0); // never zero
    expect(rec.provider).toBe("openai-tts"); // per-CHARACTER table, distinct from `openai`
    expect(rec.model).toBe("tts-1");
    expect(rec.nodeType).toBe("textToSpeech");
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);

    // The cost the run accumulates equals the exact per-character price.
    const expected = computeCost({
      provider: "openai-tts",
      model: "tts-1",
      inputTokens: TEXT.length,
      outputTokens: 0,
    });
    expect(out.costUsd).toBeCloseTo(expected, 12);
    expect(out.costUsd).toBeGreaterThan(0);
  });

  it("NEVER puts the synthesized text (or the key) in the ledger record", async () => {
    await callTextToSpeech({ text: TEXT }, null, META);
    const serialized = JSON.stringify(recordUsage.mock.calls[0][0]);
    expect(serialized).not.toContain(TEXT);
    expect(serialized).not.toContain("shipped");
    expect(serialized).not.toContain("sk-openai-secret-xyz");
  });

  it("falls back to the driver's priced model when the author names an unpriced one, so cost is never 0", async () => {
    const out = await callTextToSpeech(
      { text: TEXT, model: "some-unreleased-tts" },
      null,
      META,
    );
    // The LEDGER prices against a real row (else recordUsage's own fail-safe would book $0 and the
    // USD budget gate would see a free call)…
    expect(recordUsage.mock.calls[0][0].model).toBe("tts-1");
    expect(out.costUsd).toBeGreaterThan(0);
    // …and the row still reads MEASURED (#1060). This is the case that shows why `estimated` is
    // scoped to tokens: the PRICE here is a substitute, but the character count is exact. Flipping
    // this to true would make every unpriced-model row look like an unmeasured one.
    expect(recordUsage.mock.calls[0][0].estimated).toBe(false);
    // …while the node OUTPUT still reports what was actually requested.
    expect(out.output.model).toBe("some-unreleased-tts");
  });

  it("bills the hd rate for tts-1-hd (twice the standard per-character price)", async () => {
    const std = await callTextToSpeech({ text: TEXT }, null, META);
    const hd = await callTextToSpeech(
      { text: TEXT, model: "tts-1-hd" },
      null,
      META,
    );
    expect(hd.costUsd).toBeCloseTo(std.costUsd * 2, 12);
  });
});

describe("callTextToSpeech — error semantics", () => {
  it("maps 401 to a NON-retryable AUTH failure (don't burn retries on a bad key)", async () => {
    fetchMock.mockResolvedValue(errRes(401));
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("AUTH");
    expect(err.message).not.toContain(TEXT); // no submitted text in history
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("maps 403 to a NON-retryable AUTH failure too", async () => {
    fetchMock.mockResolvedValue(errRes(403));
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("AUTH");
  });

  it("maps 429 to a NON-retryable QUOTA failure", async () => {
    fetchMock.mockResolvedValue(errRes(429));
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("QUOTA");
  });

  it("keeps a 5xx RETRYABLE (a genuine transient) and a 4xx non-retryable", async () => {
    fetchMock.mockResolvedValue(errRes(503));
    let err: ApplicationFailure = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBeFalsy();
    expect(err.type).toBe("TTS_PROVIDER_TRANSIENT");

    fetchMock.mockResolvedValue(errRes(400));
    err = await expectFailure(callTextToSpeech({ text: TEXT }, null, META));
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("TTS_PROVIDER_REJECTED");
  });

  it("rejects empty text before any provider call or billing", async () => {
    const err = await expectFailure(
      callTextToSpeech({ text: "   " }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("TTS_NO_TEXT");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("rejects over-long text (bounds the bill) without echoing it", async () => {
    const long = "a".repeat(MAX_TTS_INPUT_CHARS + 1);
    const err = await expectFailure(
      callTextToSpeech({ text: long }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("TTS_TEXT_TOO_LONG");
    expect(err.message).not.toContain(long);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized advertised body before buffering it", async () => {
    fetchMock.mockResolvedValue(
      audioRes(64, 200, { "content-length": String(200 * 1024 * 1024) }),
    );
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("TTS_AUDIO_TOO_LARGE");
  });

  it("treats an empty-audio 200 as retryable rather than storing a 0-byte object", async () => {
    fetchMock.mockResolvedValue(audioRes(0));
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBeFalsy();
    expect(err.type).toBe("TTS_EMPTY_AUDIO");
  });

  it("wraps a raw network error in a GENERIC retryable failure (no URL/key/text in history)", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `connect ECONNREFUSED https://api.openai.com/v1/audio/speech body=${TEXT} auth=sk-openai-secret-xyz`,
      ),
    );
    const err = await expectFailure(
      callTextToSpeech({ text: TEXT }, null, META),
    );
    expect(err.nonRetryable).toBeFalsy();
    expect(err.type).toBe("TTS_TRANSIENT");
    const serialized = JSON.stringify({
      message: err.message,
      details: err.details,
    });
    expect(serialized).not.toContain(TEXT);
    expect(serialized).not.toContain("sk-openai-secret-xyz");
    expect(serialized).not.toContain("api.openai.com");
  });
});
