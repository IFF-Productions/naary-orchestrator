// textToSpeech node (#689) — synthesize text into an audio object via a BYOK TTS provider.
//
// Why its own activity rather than an integration-catalog entry: the catalog is JSON-in/JSON-out
// (`integration.ts` JSON-stringifies the body and JSON-parses the reply) and TTS returns BINARY
// audio.
//
// Three invariants worth reading before editing:
//   1. AUDIO NEVER TOUCHES TEMPORAL HISTORY. The bytes go to object storage; the result carries a
//      small `{ __objectRef, contentType, bytes }` reference. See the note on OBJECT_REF below for
//      why this is deliberately NOT the `{ __claimCheck }` shape.
//   2. BYOK, IN-ACTIVITY (Tier-1 rule 4). The tenant's provider key is fetched + decrypted here,
//      used in memory, and never returned, logged, or put in a span.
//   3. BILLING IS PER CHARACTER (Tier-1 rule 6). One synthetic token per character, so the
//      token-shaped ledger prices TTS exactly. Never zero, and never the synthesized TEXT.
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { BlockedEgressError, safeFetch } from "@naary/connections";
import { getDefaultEnvironmentId } from "@naary/db";
import { MissingCredentialError } from "@naary/secrets";
import { getObjectStore, type ObjectStore } from "@naary/storage";
import { computeCost, recordUsage } from "@naary/usage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import { contentTypeFor, resolveTtsDriver } from "../tts-drivers";
import { type AgentMeta, getCredentials } from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured logging is fine here.
// Logs carry ids + counts/costs ONLY — never the synthesized text, never the key.
const log = createLogger({ component: "worker" });

/** Default wall-clock deadline for one synthesis call. */
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;
/** Hard cap on the per-call deadline — MUST stay under the proxy's startToCloseTimeout (see
 *  proxies.ts: 5 minutes) so the AbortController, not Temporal, is the real deadline. */
export const MAX_TTS_TIMEOUT_MS = 240_000;
/** Cap on the text handed to a provider. OpenAI's /v1/audio/speech rejects >4096 chars with a 400;
 *  failing here instead makes it a clear, non-retryable config error (and bounds the bill). */
export const MAX_TTS_INPUT_CHARS = 4096;
/** Cap on the audio we will buffer + store. 4096 chars of speech is well under a megabyte at any
 *  bitrate; 25 MB is a generous ceiling that still refuses a pathological/hostile response. */
export const MAX_TTS_AUDIO_BYTES = 25 * 1024 * 1024;

/** textToSpeech config the activity needs — a subset of TextToSpeechNodeConfig with `text` ALREADY
 *  resolved by the interpreter (templates + `textBinding` applied in deterministic workflow code). */
export interface TextToSpeechActivityConfig {
  provider?: string;
  /** The resolved text to speak. */
  text: string;
  voice?: string;
  model?: string;
  format?: string;
  speed?: number;
  timeoutMs?: number;
  /** Flat fallback cost, metered only if the character-derived price can't be computed. */
  costUsd?: number;
}

/**
 * An opaque reference to a stored binary object.
 *
 * DELIBERATELY NOT `{ __claimCheck, bytes }`: the API's run-detail read resolves EVERY claim-check
 * in the run ctx (`resolveCtxRefs` → `resolveClaimChecks`) by fetching the object and `JSON.parse`ing
 * it. For audio that would either inline megabytes of base64 into every run-detail response or
 * fetch-and-discard the whole object on each poll. `__objectRef` is invisible to `isClaimCheck` and
 * to the workflow's `containsClaimCheckRef`, so the reference flows through untouched and the API
 * streams the bytes on demand from its own artifact route instead.
 */
export interface AudioObjectRef {
  __objectRef: string;
  contentType: string;
  bytes: number;
}

export interface TextToSpeechResult {
  status: "ok";
  output: {
    audio: AudioObjectRef;
    format: string;
    voice: string;
    provider: string;
    model: string;
    bytes: number;
    /** Characters synthesized — the BILLED quantity. Never the text itself. */
    characters: number;
    /** Only when the provider reports it. OpenAI's speech endpoint does not, so it is absent
     *  there — we never fabricate a duration from the byte count. */
    durationSeconds?: number;
  };
  costUsd: number;
}

/**
 * Test seam: the credential source, the network call, the object store, and the usage sink — so the
 * activity's orchestration (in-activity key fetch, offload, character billing, error mapping) is
 * unit-testable with no live provider, no DB, and no cloud bucket.
 */
export const __ttsDeps = {
  getCredentials,
  getDefaultEnvId: getDefaultEnvironmentId,
  recordUsage,
  getStore: (): ObjectStore => getObjectStore(),
  // SSRF-hardened (see safeFetch): validates every redirect hop at connect time and pins the
  // checked IP. The provider endpoint is a driver constant, but the guard is cheap and uniform.
  fetch: (url: string, init?: RequestInit): Promise<Response> =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
};

/** The ledger PROVIDER key for TTS spend. Distinct from the `openai` CREDENTIAL slot on purpose:
 *  the `openai-tts` pricing table is denominated in USD per 1M CHARACTERS, not per 1M tokens (see
 *  packages/usage/src/pricing.ts), and a separate key keeps TTS spend legible in the rollups. */
const LEDGER_PROVIDER_SUFFIX = "-tts";

/**
 * textToSpeech node. Mirrors runAgent/callCodeAgent's envelope: BYOK key fetched IN-ACTIVITY,
 * fail-safe usage (never bills zero), and auth/quota → non-retryable so Temporal doesn't burn
 * retries on a credential the user must fix.
 */
export async function callTextToSpeech(
  cfg: TextToSpeechActivityConfig,
  _input: unknown,
  meta: AgentMeta,
): Promise<TextToSpeechResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const driver = resolveTtsDriver(cfg.provider);
    const text = typeof cfg.text === "string" ? cfg.text : "";
    // A zero-character synthesis would be a billable no-op (and most providers 400 it), so it is a
    // hard config error. The message names the FIELDS, never the value.
    if (text.trim().length === 0) {
      throw ApplicationFailure.nonRetryable(
        "textToSpeech has no text to speak — set `text` or bind `textBinding` to an upstream output.",
        "TTS_NO_TEXT",
      );
    }
    if (text.length > MAX_TTS_INPUT_CHARS) {
      throw ApplicationFailure.nonRetryable(
        `textToSpeech input is ${text.length} characters; the limit is ${MAX_TTS_INPUT_CHARS}. Split the text across nodes.`,
        "TTS_TEXT_TOO_LONG",
      );
    }

    const format = cfg.format ?? "mp3";
    const contentType = contentTypeFor(format);
    const model = cfg.model || driver.defaultModel;
    const voice = cfg.voice || driver.defaultVoice;
    const characters = text.length;

    // In memory only — passed to the provider as a request header, never returned/logged. Env-scoped
    // creds: the run's env (5b) selects the key; a pre-5b run falls back to the tenant default.
    const envId =
      meta.environmentId ?? (await __ttsDeps.getDefaultEnvId(meta.tenantId));
    const apiKey = await __ttsDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, envId, driver.credentialProvider);

    const req = driver.buildRequest(
      { text, voice, model, format, speed: cfg.speed },
      apiKey,
    );

    const timeoutMs = Math.min(
      Math.max(cfg.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS, 1_000),
      MAX_TTS_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await __ttsDeps.fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The response BODY of a failed TTS call can echo the submitted text back (providers quote the
      // offending `input`), so it is NEVER read into the error — only the status code travels into
      // Temporal history. 401/403 (bad key) and 429 (exhausted quota) are things the user must fix,
      // so they don't burn retries; 5xx is genuinely transient.
      if (res.status === 401 || res.status === 403) {
        throw ApplicationFailure.nonRetryable(
          `The ${driver.provider} text-to-speech credential was rejected (status ${res.status}) — check the key under Settings → Providers.`,
          "AUTH",
          { statusCode: res.status },
        );
      }
      if (res.status === 429) {
        throw ApplicationFailure.nonRetryable(
          `The ${driver.provider} text-to-speech quota is exhausted or rate-limited (status 429).`,
          "QUOTA",
          { statusCode: 429 },
        );
      }
      if (res.status >= 500) {
        throw ApplicationFailure.retryable(
          `The ${driver.provider} text-to-speech request failed (status ${res.status}).`,
          "TTS_PROVIDER_TRANSIENT",
          { statusCode: res.status },
        );
      }
      throw ApplicationFailure.nonRetryable(
        `The ${driver.provider} text-to-speech request was rejected (status ${res.status}) — check the voice/model/format.`,
        "TTS_PROVIDER_REJECTED",
        { statusCode: res.status },
      );
    }

    // Pre-check the advertised size so a pathological response is refused before it is buffered,
    // then re-check the real length (content-length is a hint, not a guarantee).
    const advertised = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > MAX_TTS_AUDIO_BYTES) {
      throw ApplicationFailure.nonRetryable(
        `The synthesized audio is larger than the ${MAX_TTS_AUDIO_BYTES}-byte limit.`,
        "TTS_AUDIO_TOO_LARGE",
      );
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.byteLength === 0) {
      throw ApplicationFailure.retryable(
        `The ${driver.provider} text-to-speech response carried no audio.`,
        "TTS_EMPTY_AUDIO",
      );
    }
    if (audio.byteLength > MAX_TTS_AUDIO_BYTES) {
      throw ApplicationFailure.nonRetryable(
        `The synthesized audio is larger than the ${MAX_TTS_AUDIO_BYTES}-byte limit.`,
        "TTS_AUDIO_TOO_LARGE",
      );
    }

    // Object key is DERIVED from execution+node (not a random uuid) so an at-most-once retry
    // overwrites the same object instead of orphaning one, and the API can address it from the run
    // ctx alone. Tenant-prefixed for the same isolation reason as the other offload prefixes.
    const key = `tts/${meta.tenantId}/${meta.executionId}/${meta.nodeId}.${format}`;
    const ref = await __ttsDeps.getStore().put(key, audio);

    // BILLING (Tier-1 rule 6). TTS bills per CHARACTER and OpenAI's speech endpoint reports NO
    // usage at all, so characters are the PRIMARY quantity, not a fallback: one synthetic token per
    // character, recorded as inputTokens against the per-1M-CHARACTER `openai-tts` price table. That
    // yields the exact provider price with no ledger schema change. Never zero (text is non-empty,
    // checked above); never the text itself.
    const ledgerProvider = `${driver.provider}${LEDGER_PROVIDER_SUFFIX}`;
    // If the author named a model with no pricing row, `recordUsage`'s internal fail-safe would book
    // cost 0 (tokens-without-cost) and the USD budget gate would see a free call. Price against the
    // driver's DEFAULT (priced) model instead — a deliberate fallback ESTIMATE, same reasoning as
    // codeAgent pricing an unknown CLI model against a real Claude one.
    let pricedModel = model;
    let costUsd: number | undefined;
    try {
      costUsd = computeCost({
        provider: ledgerProvider,
        model: pricedModel,
        inputTokens: characters,
        outputTokens: 0,
      });
    } catch {
      pricedModel = driver.defaultModel;
      try {
        costUsd = computeCost({
          provider: ledgerProvider,
          model: pricedModel,
          inputTokens: characters,
          outputTokens: 0,
        });
      } catch {
        costUsd = undefined;
      }
    }
    await __ttsDeps.recordUsage({
      tenantId: meta.tenantId,
      environmentId: meta.environmentId, // per-env cost tag (Slice 6)
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      nodeType: "textToSpeech", // by-node-type rollups without a graph join
      durationMs: Math.round(secondsSince(startedAt) * 1000),
      provider: ledgerProvider,
      model: pricedModel,
      usage: {
        inputTokens: characters,
        outputTokens: 0,
        totalTokens: characters,
      },
      // #1060: FALSE, and this is the one site where that deserves a sentence. TTS bills per
      // character and we COUNTED the characters we sent — that is a measurement, not a fallback,
      // even though no provider "usage" object was involved. The `pricedModel` fallback a few lines
      // up IS an approximation, but it approximates the PRICE, not the quantity; `estimated` is
      // scoped to tokens precisely so those two stay separable in an audit.
      estimated: false,
    });
    const accumulatedCost = costUsd ?? cfg.costUsd ?? 0;

    log.info(
      {
        activity: "callTextToSpeech",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider: driver.provider,
        model,
        voice,
        format,
        // Quantities only — the synthesized TEXT is never logged (same rule as prompts).
        characters,
        bytes: audio.byteLength,
        costUsd: accumulatedCost,
      },
      "textToSpeech node completed",
    );
    activityRuns.inc({ activity: "callTextToSpeech", outcome: "ok" });
    activityDuration.observe(
      { activity: "callTextToSpeech" },
      secondsSince(startedAt),
    );
    if (accumulatedCost > 0) runCostUsd.inc(accumulatedCost);

    return {
      status: "ok",
      output: {
        audio: { __objectRef: ref, contentType, bytes: audio.byteLength },
        format,
        voice,
        provider: driver.provider,
        model,
        bytes: audio.byteLength,
        characters,
      },
      costUsd: accumulatedCost,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callTextToSpeech", outcome: "error" });
    activityDuration.observe(
      { activity: "callTextToSpeech" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof MissingCredentialError) {
      throw ApplicationFailure.nonRetryable(
        "Missing or invalid provider credential",
        "AUTH",
        { tenantId: meta.tenantId },
      );
    }
    if (
      e instanceof BlockedEgressError ||
      (e instanceof Error && e.name === "BlockedEgressError")
    ) {
      throw ApplicationFailure.nonRetryable(
        "The text-to-speech endpoint resolved to a blocked address.",
        "BLOCKED_EGRESS",
      );
    }
    // A network/undici error's message can carry the request URL and, for some error classes, the
    // request init (which holds the Authorization header AND the submitted text). Throw a FULLY
    // GENERIC failure and keep only safe classifiers in the worker log — same treatment as the
    // codeAgent subprocess path.
    log.warn(
      {
        activity: "callTextToSpeech",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        errorName: e instanceof Error ? e.name : "unknown",
        errorCode:
          typeof (e as { code?: unknown }).code === "string" ||
          typeof (e as { code?: unknown }).code === "number"
            ? (e as { code: string | number }).code
            : undefined,
      },
      "textToSpeech call failed (details suppressed from workflow history)",
    );
    throw ApplicationFailure.retryable(
      "The text-to-speech call failed (transient).",
      "TTS_TRANSIENT",
    );
  }
}
