/**
 * Synthesized-audio player for a textToSpeech node's output (#689).
 *
 * The node output NEVER carries bytes — it carries `{ audio: { __objectRef, contentType, bytes } }`
 * and the API streams the object on demand from `GET /executions/:id/nodes/:nodeId/audio`. That
 * route is authenticated like every other one, and `<audio src="/api/…">` would NOT send the bearer
 * token (the browser issues a plain media request), so we fetch it ourselves with the same
 * bearer/workspace/environment headers the API client uses and play a `blob:` object URL.
 *
 * Fetch happens on an explicit click, not on mount: the pre-snapshot RunDetail layout renders one
 * NodeOutputBody per ctx entry, so a mount-fetch would download every TTS node's audio on page load
 * — and with the default in-memory object store (which lives in the WORKER process, not the API)
 * every one of those 404s. A click keeps the honest "no longer in storage" message a response to a
 * user action instead of ambient noise.
 */
import { useEffect, useState } from "react";
import { getActiveEnvironment, getActiveWorkspace } from "../../../lib/api";
import { BASE } from "../../../lib/api/http";
import { getBearerToken } from "../../../lib/firebase";

/** The non-auto-resolved object reference a textToSpeech node writes to the run ctx. */
export interface AudioRef {
  __objectRef: string;
  contentType: string;
  bytes: number;
}

/**
 * Pull the audio reference out of a node output (`{ status, output: { audio, … }, costUsd }`).
 * Returns undefined for every other node shape — this is the ONLY thing that decides whether a
 * player renders, so it is deliberately strict about all three fields.
 */
export function extractAudioRef(output: unknown): AudioRef | undefined {
  if (!output || typeof output !== "object") return undefined;
  const inner = (output as { output?: unknown }).output;
  if (!inner || typeof inner !== "object") return undefined;
  const audio = (inner as { audio?: unknown }).audio;
  if (!audio || typeof audio !== "object") return undefined;
  const a = audio as Partial<AudioRef>;
  if (typeof a.__objectRef !== "string" || !a.__objectRef) return undefined;
  if (typeof a.contentType !== "string" || !a.contentType) return undefined;
  if (typeof a.bytes !== "number" || !Number.isFinite(a.bytes))
    return undefined;
  return {
    __objectRef: a.__objectRef,
    contentType: a.contentType,
    bytes: a.bytes,
  };
}

/** The API path that streams a node's audio. Both segments are encoded — a node id is
 *  user-authored and can contain characters that would otherwise change the route. */
export function nodeAudioPath(runId: string, nodeId: string): string {
  return `/executions/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/audio`;
}

/** contentType → download extension. Falls back to a bare name rather than guessing wrong. */
const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/opus": "opus",
  "audio/ogg": "opus",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/pcm": "pcm",
  "audio/basic": "pcm",
};

/** Suggested "Save as" name for a node's audio; extension only when we truly know the type. */
export function audioFileName(nodeId: string, contentType: string): string {
  const ext = EXT_BY_TYPE[contentType.split(";")[0].trim().toLowerCase()];
  const safe = nodeId.replace(/[^A-Za-z0-9._-]+/g, "-") || "audio";
  return ext ? `${safe}.${ext}` : safe;
}

function kib(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

const linkStyle = {
  fontSize: "var(--text-2xs)",
  color: "var(--ink-3)",
  textDecoration: "underline",
} as const;

const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--line-mid)",
  background: "var(--card)",
  color: "var(--ink-soft)",
  borderRadius: 8,
  padding: "5px 11px",
  cursor: "pointer",
  fontSize: "var(--text-xs)",
} as const;

export function NodeAudio({
  runId,
  nodeId,
  audio,
}: {
  runId: string;
  nodeId: string;
  audio: AudioRef;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Revoke whenever the URL is replaced AND on unmount — the pre-snapshot list doesn't remount
  // when the selection changes, so an unmount-only cleanup would leak on a re-fetch.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const token = await getBearerToken();
      const workspaceId = getActiveWorkspace();
      const environmentId = getActiveEnvironment();
      const res = await fetch(`${BASE}${nodeAudioPath(runId, nodeId)}`, {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
          ...(environmentId ? { "x-environment-id": environmentId } : {}),
        },
      });
      if (res.status === 404) {
        // Expected in a dev setup: the default in-memory object store lives in the worker
        // process, so the API genuinely cannot see the object. Say so, don't crash.
        setError("Audio is no longer available in storage.");
        return;
      }
      if (res.status === 401) {
        setError("Your session expired — reload the page and sign in again.");
        return;
      }
      if (!res.ok) {
        setError(`Couldn't load the audio (HTTP ${res.status}).`);
        return;
      }
      const blob = await res.blob();
      // Trust the ref's contentType over an empty/generic blob type so <audio> gets a real one.
      setUrl(
        URL.createObjectURL(
          blob.type ? blob : new Blob([blob], { type: audio.contentType }),
        ),
      );
    } catch {
      setError("Couldn't load the audio — the request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>Synthesized audio</span>
        <span>
          {audio.contentType} · {kib(audio.bytes)}
        </span>
      </div>

      {url ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: synthesized speech of text already shown in the output */}
          <audio controls src={url} style={{ width: "100%" }} />
          <a
            href={url}
            download={audioFileName(nodeId, audio.contentType)}
            style={linkStyle}
          >
            Download audio
          </a>
        </>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={{ ...buttonStyle, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Loading…" : "▶ Load audio"}
          </button>
          {error && (
            <span
              style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
              role="status"
            >
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
