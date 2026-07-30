/**
 * Conversational AI builder sessions (docs/design/AI-BUILDER-CONVERSATION.md).
 *
 * A session is a persisted, server-side working draft + conversation: open one,
 * send natural-language turns that EDIT the draft (each turn streams the edited
 * graph over SSE with the same frame protocol as /graphs/generate/stream —
 * `meta`/`node`/`edge`, terminal `result` or `error`), resume it later, close it
 * on save or Done. Consumed by the Build with AI screen; deliberately NOT merged
 * into the `api` barrel yet — import { builderApi } directly.
 */
import type { GraphDef } from "@naary/dsl";
import { getBearerToken } from "../firebase-lazy";
import { createSseParser } from "../sse";
import {
  AccessNotAllowedError,
  BASE,
  getActiveEnvironment,
  getActiveWorkspace,
  http,
  UnauthorizedError,
} from "./http";

/** One conversation turn — the user's prompt, or a short assistant change-summary
 *  (the server writes the assistant turn itself after a successful edit). */
export interface BuilderTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Metered BYOK cost of an assistant turn; null/absent on user turns. */
  costUsd?: number | null;
  /** Tappable quick-reply suggestions on an assistant turn (#487); selecting one
   *  becomes the next user turn. Empty/absent on user turns. */
  options?: string[];
  createdAt: string;
}

/** The accept-flavored quick reply — the UI maps a tap on this to "Open in canvas"
 *  (save), not another edit turn. Keep in sync with `SAVE_OPTION` in
 *  apps/api/src/builder/turn-metering.ts. */
export const SAVE_OPTION = "Looks good — save it";

/** A full builder session: status + working draft + conversation. */
export interface BuilderSession {
  id: string;
  status: "open" | "closed";
  closedReason?: "saved" | "done" | "abandoned" | null;
  workflowKey?: string | null;
  environmentId?: string | null;
  title?: string | null;
  /** The latest validated working draft, or null before the first turn. */
  currentGraph?: GraphDef | null;
  turns: BuilderTurn[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

/** Lightweight row for the "resume a build" list (no graph body / turns). */
export interface BuilderSessionSummary {
  id: string;
  status: "open" | "closed";
  workflowKey?: string | null;
  title?: string | null;
  updatedAt: string;
}

export const builderApi = {
  /** Open a session (optionally seeded from an existing workflow's graph). */
  openBuilderSession(opts?: {
    workflowKey?: string;
    title?: string;
  }): Promise<BuilderSession> {
    return http("/builder/sessions", {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  },
  /** Open sessions in the active environment — the resume list. */
  listBuilderSessions(): Promise<BuilderSessionSummary[]> {
    return http("/builder/sessions");
  },
  /** Resume: the session's status, current draft and conversation. */
  getBuilderSession(id: string): Promise<BuilderSession> {
    return http(`/builder/sessions/${encodeURIComponent(id)}`);
  },
  /** Close on save ("saved") or an explicit Done ("done"). */
  closeBuilderSession(
    id: string,
    reason: "saved" | "done",
  ): Promise<BuilderSession> {
    return http(`/builder/sessions/${encodeURIComponent(id)}/close`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },

  /**
   * Send an edit turn and stream the edited draft (SSE). `hooks` receive the live
   * frames as the model builds — `onMeta(name)` once the workflow name is known,
   * then `onNode`/`onEdge` per completed element — so the stage can draw the
   * workflow incrementally. The resolved value is the authoritative validated
   * graph (the `result` frame); callers reconcile to it. On success the server
   * has already appended the user turn + an assistant change-summary and updated
   * `currentGraph` — re-fetch the session to show the real assistant turn.
   *
   * Pre-stream failures surface as real HTTP errors (400 empty message, 404 not
   * this workspace's session, 409 closed, 402 over monthly budget); mid-stream
   * failures arrive as an `error` frame. Both throw here with the server message.
   */
  async sendBuilderTurn(
    sessionId: string,
    message: string,
    provider?: string,
    hooks?: {
      onMeta?: (name: string) => void;
      onNode?: (node: unknown) => void;
      onEdge?: (edge: unknown) => void;
    },
  ): Promise<{ name: string; graph: GraphDef }> {
    const token = await getBearerToken();
    const activeWorkspaceId = getActiveWorkspace();
    const activeEnvironmentId = getActiveEnvironment();
    const res = await fetch(
      `${BASE}/builder/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
          ...(activeEnvironmentId
            ? { "x-environment-id": activeEnvironmentId }
            : {}),
        },
        body: JSON.stringify(provider ? { message, provider } : { message }),
      },
    );
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      // Pre-stream failures (validation 400, 404/409/402 guards) are plain JSON —
      // mirror http()'s mapping but surface the server message.
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string | string[];
      } | null;
      const msg = Array.isArray(body?.message)
        ? body.message.join("; ")
        : body?.message;
      if (res.status === 403 && body?.code === "access_not_allowed") {
        throw new AccessNotAllowedError(msg);
      }
      throw new Error(
        msg ?? `POST /builder/sessions/:id/turns → ${res.status}`,
      );
    }
    // Defensive skew tolerance: a proxy/server that answered JSON instead of SSE.
    if (
      !res.headers.get("content-type")?.includes("text/event-stream") ||
      !res.body
    ) {
      return res.json() as Promise<{ name: string; graph: GraphDef }>;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      const { done, value } = await reader.read();
      const frames = parser.push(
        done ? decoder.decode() : decoder.decode(value, { stream: true }),
      );
      for (const frame of frames) {
        if (frame.event === "meta") {
          try {
            const { name } = JSON.parse(frame.data) as { name?: string };
            if (name && hooks?.onMeta) hooks.onMeta(name);
          } catch {
            /* ignore a malformed meta frame — the result frame is authoritative */
          }
          continue;
        }
        if (frame.event === "node") {
          try {
            hooks?.onNode?.(JSON.parse(frame.data));
          } catch {
            /* ignore a half/garbled node frame; result reconciles */
          }
          continue;
        }
        if (frame.event === "edge") {
          try {
            hooks?.onEdge?.(JSON.parse(frame.data));
          } catch {
            /* ignore a half/garbled edge frame; result reconciles */
          }
          continue;
        }
        if (frame.event === "result") {
          return JSON.parse(frame.data) as { name: string; graph: GraphDef };
        }
        if (frame.event === "error") {
          const err = JSON.parse(frame.data) as {
            status: number;
            message?: string;
            code?: string;
          };
          if (err.status === 401) throw new UnauthorizedError();
          if (err.status === 403 && err.code === "access_not_allowed") {
            throw new AccessNotAllowedError(err.message);
          }
          throw new Error(err.message ?? "Couldn't apply that change.");
        }
      }
      if (done) break;
    }
    throw new Error("The build stream ended unexpectedly. Try again.");
  },
};
