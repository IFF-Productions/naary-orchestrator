/**
 * Build with AI (design "Naary AI Generate.dc.html") — conversational workflow
 * generation over the REAL builder-session API (docs/design/AI-BUILDER-CONVERSATION.md).
 *
 * The backend is multi-turn but does NOT ask clarifying questions: every message
 * is an edit turn that immediately (re)builds the working draft, streaming
 * `meta`/`node`/`edge` SSE frames we draw live on the right-hand stage. So the
 * screen's honest flow is: describe → Building (typing dots until the first
 * frame, then the plan card + live stage) → Draft ready → refine by chatting →
 * "Open in canvas" saves the draft via POST /graphs and navigates to the editor.
 * After each edit the newest assistant turn carries deterministic quick-reply
 * options (#487): tapping one becomes the next turn (or, for the accept option,
 * opens the draft in canvas). See ConversationPanel for the chip rendering.
 *
 * This module is the route container (session lifecycle + turn SSE); the
 * presentational shell lives in ./build-ai/BuildWithAiView.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { api } from "../../lib/api";
import { builderApi, type BuilderSession } from "../../lib/api/builder";
import {
  BuildWithAiView,
  type BuildWithAiState,
  INITIAL_BUILD_STATE,
} from "./build-ai/BuildWithAiView";
import type { ChatMsg } from "./build-ai/ConversationPanel";
import { asEdgeDef, asNodeDef, slugifyName } from "./build-ai/model";
import {
  type AiBuilderProvider,
  providerOptions,
  providerSetupHint,
  resolveStoredProvider,
} from "./build-ai/providers";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

/** Remembered provider choice. localStorage can THROW (sandboxed iframe, private mode), and a
 *  preference is never worth failing a screen over — both helpers swallow. */
const PROVIDER_KEY = "naary-build-ai-provider";

function readStoredProvider(): string | null {
  try {
    return localStorage.getItem(PROVIDER_KEY);
  } catch {
    return null;
  }
}

function writeStoredProvider(value: AiBuilderProvider | null): void {
  try {
    if (value) localStorage.setItem(PROVIDER_KEY, value);
    else localStorage.removeItem(PROVIDER_KEY);
  } catch {
    /* preference only */
  }
}

function turnsToMessages(s: BuilderSession): ChatMsg[] {
  return s.turns.map((t) => ({
    id: t.id,
    role: t.role === "assistant" ? "assistant" : "user",
    text: t.content,
    costUsd: t.costUsd,
    options: t.options ?? [],
  }));
}

/** Route component — owns the session lifecycle + the turn SSE. */
export function BuildWithAi() {
  const navigate = useNavigate();
  const [state, setState] = useState<BuildWithAiState>(INITIAL_BUILD_STATE);
  const sessionRef = useRef<string | null>(null);
  // The authoritative draft (terminal `result` frame / resumed currentGraph).
  const graphRef = useRef<{ name: string; graph: GraphDef } | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const patch = useCallback((p: Partial<BuildWithAiState>) => {
    if (aliveRef.current) setState((s) => ({ ...s, ...p }));
  }, []);

  /**
   * Which model/agent to generate with. `null` = Auto, i.e. send no provider and let the server apply
   * its own precedence (first VALID credential, API models before claude-code) — exactly what happened
   * before this picker existed, so the default behaviour is unchanged.
   *
   * The choice is remembered across visits, but validated against what's currently configured on load:
   * a stored provider whose credential was removed (or has since failed validation) would 400 on send,
   * and a 400 on a preference the user didn't re-choose is the most confusing failure available.
   */
  const { activeId: tenantId } = useWorkspace();
  const [credentials, setCredentials] = useState<
    { provider: string; isValid: boolean }[] | null
  >(null);
  const [provider, setProvider] = useState<AiBuilderProvider | null>(null);
  // `send` is a useCallback keyed on [patch], so it would capture a stale `provider`. Mirror it in a
  // ref (like sessionRef/graphRef above) so the turn always uses the CURRENT selection.
  const providerRef = useRef<AiBuilderProvider | null>(null);
  providerRef.current = provider;
  const options = providerOptions(credentials);

  // Keyed on tenantId only: switching ENVIRONMENT remounts this screen (AppShell keys the Outlet by
  // the active env), so the list refetches for the new env without an extra dependency. The endpoint
  // is env-scoped through the same resolveEnvId the generator uses, so what's offered is exactly what
  // will resolve.
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api
      .listCredentials(tenantId)
      .then((rows) => {
        if (cancelled) return;
        setCredentials(rows);
        // Restore the remembered choice only if it's still usable.
        setProvider(
          resolveStoredProvider(
            readStoredProvider(),
            providerOptions(rows),
          ),
        );
      })
      // A failed credential list must not block generating: Auto still works, and the server returns
      // its own actionable error if nothing is configured.
      .catch(() => !cancelled && setCredentials([]));
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const chooseProvider = useCallback((next: AiBuilderProvider | null) => {
    setProvider(next);
    writeStoredProvider(next);
  }, []);

  // The resume list — real open sessions in the active environment.
  useEffect(() => {
    builderApi
      .listBuilderSessions()
      .then((rows) => patch({ resumables: rows }))
      .catch(() => patch({ resumables: [] }));
  }, [patch]);

  const send = useCallback(
    async (text: string) => {
      // The user turn is real — it's the message we send; the server persists it.
      const localId = `local-${Date.now()}`;
      setState((s) => ({
        ...s,
        phase: "streaming",
        typing: true,
        gotFrame: false,
        error: null,
        messages: [...s.messages, { id: localId, role: "user", text }],
      }));
      try {
        let sid = sessionRef.current;
        if (!sid) {
          sid = (await builderApi.openBuilderSession()).id;
          sessionRef.current = sid;
        }
        // The server streams the WHOLE edited graph each turn — the first frame
        // resets the stage (a refine re-streams everything), then elements
        // accumulate as frames land. Bookkeeping lives OUTSIDE the setState
        // updaters so they stay pure (StrictMode replays them).
        let first = true;
        const seen = new Set<string>();
        const takeFirst = (): boolean => {
          const was = first;
          first = false;
          return was;
        };
        const result = await builderApi.sendBuilderTurn(sid, text, providerRef.current ?? undefined, {
          onMeta: (name) => patch({ name }),
          onNode: (raw) => {
            const n = asNodeDef(raw);
            if (!n || !aliveRef.current || seen.has(n.id)) return;
            seen.add(n.id);
            const reset = takeFirst();
            setState((s) => ({
              ...s,
              typing: false,
              gotFrame: true,
              streamNodes: reset ? [n] : [...s.streamNodes, n],
              streamEdges: reset ? [] : s.streamEdges,
            }));
          },
          onEdge: (raw) => {
            const e = asEdgeDef(raw);
            if (!e || !aliveRef.current) return;
            const reset = takeFirst();
            setState((s) => ({
              ...s,
              typing: false,
              gotFrame: true,
              streamNodes: reset ? [] : s.streamNodes,
              streamEdges: reset ? [e] : [...s.streamEdges, e],
            }));
          },
        });
        graphRef.current = result;
        // Reconcile the stage to the authoritative validated graph, and pull the
        // persisted turns (incl. the server-written assistant change-summary).
        let messages: ChatMsg[] | null = null;
        try {
          messages = turnsToMessages(await builderApi.getBuilderSession(sid));
        } catch {
          /* thread refresh failed — keep the optimistic user turn; the plan card
             already shows the build completed. No fabricated assistant text. */
        }
        patch({
          phase: "ready",
          typing: false,
          gotFrame: true,
          name: result.name,
          streamNodes: result.graph.nodes,
          streamEdges: result.graph.edges,
          ...(messages ? { messages } : {}),
        });
      } catch (e) {
        patch({
          phase: graphRef.current ? "ready" : "idle",
          typing: false,
          error:
            e instanceof Error
              ? e.message
              : "Couldn't build that. Make sure an AI provider is connected (Integrations).",
        });
      }
    },
    [patch],
  );

  const resume = useCallback(
    async (id: string) => {
      try {
        const s = await builderApi.getBuilderSession(id);
        sessionRef.current = s.id;
        const graph = (s.currentGraph as GraphDef | null) ?? null;
        if (graph) {
          graphRef.current = { name: s.title ?? "Untitled workflow", graph };
        }
        patch({
          phase: graph ? "ready" : "idle",
          messages: turnsToMessages(s),
          name: s.title ?? null,
          streamNodes: graph?.nodes ?? [],
          streamEdges: graph?.edges ?? [],
          gotFrame: false,
          error: null,
        });
      } catch {
        patch({ error: "Couldn't resume that session." });
      }
    },
    [patch],
  );

  const openInCanvas = useCallback(async () => {
    const draft = graphRef.current;
    if (!draft) return;
    patch({ opening: true });
    try {
      const key = slugifyName(draft.name);
      await api.saveGraph(key, draft.name, draft.graph);
      const sid = sessionRef.current;
      if (sid) {
        await builderApi.closeBuilderSession(sid, "saved").catch(() => {
          /* the draft is saved either way; the session reaper handles leftovers */
        });
      }
      navigate(`/app/canvas?key=${encodeURIComponent(key)}`);
    } catch (e) {
      patch({
        opening: false,
        error:
          e instanceof Error ? e.message : "Couldn't save the draft workflow.",
      });
    }
  }, [navigate, patch]);

  const reset = useCallback(() => {
    // Leave the old session open server-side (resumable); start fresh here.
    sessionRef.current = null;
    graphRef.current = null;
    setState((s) => ({ ...INITIAL_BUILD_STATE, resumables: s.resumables }));
    builderApi
      .listBuilderSessions()
      .then((rows) => patch({ resumables: rows }))
      .catch(() => undefined);
  }, [patch]);

  return (
    <BuildWithAiView
      state={state}
      onSend={(t) => void send(t)}
      providerOptions={options}
      provider={provider}
      onProvider={chooseProvider}
      providerHint={providerSetupHint(options)}
      onResume={(id) => void resume(id)}
      onOpenInCanvas={() => void openInCanvas()}
      onReset={reset}
    />
  );
}
