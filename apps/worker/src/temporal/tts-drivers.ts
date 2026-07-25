/**
 * Text-to-speech drivers (#689). The `textToSpeech` node is provider-agnostic: a driver adapts one
 * TTS API behind a common contract. Everything provider-specific — the endpoint, the request body,
 * the credential slot, the default voice/model, and how a format maps to a MIME type — lives here;
 * the activity (`callTextToSpeech`) stays provider-independent.
 *
 * These functions are PURE (build a request / map a format). The HTTP call, the credential fetch,
 * the object-storage write and the billing all live in the activity, so drivers are trivially
 * unit-testable and no secret ever passes through this module except as the caller's argument to
 * `buildRequest` (which returns it inside the headers it hands straight back to the activity — it
 * is never logged, stored, or returned in the activity's result).
 *
 * Slice 1 ships ONE verified driver (OpenAI `/v1/audio/speech`). Adding ElevenLabs / Google Cloud
 * TTS / Azure Speech / Deepgram is a driver entry here plus a `provider` enum value in the DSL
 * schema — deliberately NOT done blind: a driver whose request shape we cannot verify is worse
 * than one we can (same reasoning as the copilot code-agent driver's caveat).
 */

/** Audio containers the node exposes. Kept in sync with the DSL schema's `format` enum. */
export type TtsFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export type TtsProvider = "openai";

/** Content types for the supported containers — used for the stored object + the HTTP response
 *  the run view plays. `pcm` is raw 24 kHz mono s16le, which has no standard container type. */
const CONTENT_TYPES: Record<TtsFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "application/octet-stream",
};

/** MIME type for a container. Defaults to mp3's (the node's default format). */
export function contentTypeFor(format: string | undefined): string {
  return CONTENT_TYPES[(format ?? "mp3") as TtsFormat] ?? CONTENT_TYPES.mp3;
}

export interface TtsRequestOpts {
  text: string;
  voice?: string;
  model?: string;
  format?: string;
  speed?: number;
}

/** The concrete HTTP request a driver wants made. `headers` carries the BYOK credential — the
 *  activity passes it to `safeFetch` and drops it; it is never logged or returned. */
export interface TtsHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Already-serialized request body (JSON for every driver so far). */
  body: string;
}

export interface TtsDriver {
  provider: TtsProvider;
  /** The BYOK credential provider slot to read for this driver. Reuses the tenant's existing
   *  `openai` model-provider key — TTS is the same account/token, unlike codeAgent's CLI tokens
   *  which genuinely needed their own slot. */
  credentialProvider: string;
  defaultModel: string;
  defaultVoice: string;
  /** Build the provider call. PURE. */
  buildRequest(opts: TtsRequestOpts, apiKey: string): TtsHttpRequest;
}

/**
 * OpenAI TTS — `POST https://api.openai.com/v1/audio/speech` returns the raw audio BYTES (not
 * JSON), which is exactly why this can't ride the declarative integration catalog. The response
 * carries no usage/duration metadata at all, so characters are the PRIMARY billing quantity (see
 * the activity), not a fallback.
 */
const openaiDriver: TtsDriver = {
  provider: "openai",
  credentialProvider: "openai",
  defaultModel: "tts-1",
  defaultVoice: "alloy",
  buildRequest(opts, apiKey) {
    return {
      url: "https://api.openai.com/v1/audio/speech",
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "audio/*",
      },
      body: JSON.stringify({
        model: opts.model || openaiDriver.defaultModel,
        voice: opts.voice || openaiDriver.defaultVoice,
        input: opts.text,
        response_format: opts.format ?? "mp3",
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      }),
    };
  },
};

const DRIVERS: Record<TtsProvider, TtsDriver> = { openai: openaiDriver };

/** Resolve the driver for a provider (default "openai"). Tolerant of any runtime string so a stale
 *  saved graph naming a removed provider fails cleanly instead of crashing. */
export function resolveTtsDriver(provider: string | undefined): TtsDriver {
  const driver = DRIVERS[(provider ?? "openai") as TtsProvider];
  if (!driver) {
    throw new Error(
      `textToSpeech: unknown provider "${provider}" (expected openai).`,
    );
  }
  return driver;
}
