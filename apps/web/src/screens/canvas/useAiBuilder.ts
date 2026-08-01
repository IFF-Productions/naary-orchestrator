/**
 * The canvas's AI builder — a CONVERSATION over the real builder-session API (#1003).
 *
 * It used to be one-shot: a prompt, a Generate button, a whole graph, take it or leave it. Refining
 * meant retyping the request from scratch, and nothing on screen remembered what had already been
 * asked for. The Build with AI screen had grown the good version of this — a persisted session, a
 * message thread, a real assistant summary and per-turn BYOK cost — and the canvas was simply still
 * wired to `POST /graphs/generate/stream`. This hook moves it onto the same `/builder/sessions`
 * path, so both surfaces are the same feature rather than two features that resemble each other.
 *
 * WHAT STAYS THE SAME. Turns stream onto the LIVE react-flow canvas exactly as generations did:
 * each `node`/`edge` frame is drawn as it lands (`makeStreamPositions` keeping untouched nodes
 * where they were, so a faithful edit doesn't read as a rewrite), then the whole canvas reconciles
 * to the validated `result`. The playful rotating status and the node counter still feed the
 * canvas's own progress pill.
 *
 * WHAT IS NEW, AND WHY IT NEEDED A SERVER CHANGE. Each turn sends the LIVE COMPILED CANVAS as the
 * graph to edit. The session's stored `currentGraph` would have been wrong: this panel is a strip
 * under the top bar and the canvas stays fully editable beneath it, so a user can drag or
 * reconfigure a node between turns, and the next turn would have come back with those hand-edits
 * quietly removed. See `apps/api/src/builder/turn-input.ts`.
 */
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Node, type ReactFlowInstance } from "@xyflow/react";
import type { SetURLSearchParams } from "react-router-dom";
import type { GraphDef, NodeDef } from "@naary/dsl";
import { api } from "../../lib/api";
import { builderApi, type BuilderSession } from "../../lib/api/builder";
import { decompileGraph } from "../../lib/decompile-graph";
import { useRotatingProgressMessage } from "../../lib/use-progress-message";
import type { BuildPhase, ChatMsg } from "../app/build-ai/ConversationPanel";
import { asEdgeDef, asNodeDef, planFromStream } from "../app/build-ai/model";
import {
  type AiBuilderProvider,
  providerOptions,
  providerSetupHint,
  readStoredProvider,
  resolveStoredProvider,
  writeStoredProvider,
} from "../app/build-ai/providers";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import {
  type FlowEdge,
  type NaaryData,
  toFlowEdges,
  toFlowNodes,
} from "./flow";
import { makeStreamPositions } from "./stream-positions";

/** What the panel does with what's already on the canvas: change it, or replace it. */
export type AiMode = "edit" | "create";

/**
 * Does a LANDED generation become the unsaved-changes guard's new baseline?
 *
 * Only a CREATE. It presents a graph rather than editing one — the same act as opening a template
 * — so there is no prior state the user is departing from.
 *
 * An EDIT must not. It produces unsaved changes to an already-saved workflow, which is exactly
 * what the guard exists to catch; re-baselining marks the AI's work clean the moment it lands, and
 * leaving the canvas then discards it silently. #874 (edit mode) and #919 (the guard) were each
 * right on their own and nothing tested them together, so the composed behaviour was wrong with no
 * test to notice. Extracted as a named predicate for that reason — the rule is one boolean, but it
 * is a boolean that has now been got wrong once and is invisible at the call site.
 *
 * MULTI-TURN MAKES IT SHARPER, not looser. In a conversation only the turn that CREATED the draft
 * is a create; every refinement after it is an edit of what is now on the canvas. So a chat that
 * starts from scratch rebaselines exactly once, on turn 1, and each later turn is unsaved work
 * against that draft — which is what the guard and "Review changes" both need to be true.
 */
export function shouldRebaselineAfterGeneration(mode: AiMode): boolean {
  return mode === "create";
}

/**
 * Does this turn need a NEW session?
 *
 * "Start a new one" means a new workflow, and a new workflow is a new conversation: the thread so
 * far is about a different thing, and — the part that matters — a session opened against workflow A
 * carries A's `workflowKey`. Reusing it for an invention would leave a session bound to A whose
 * draft is not A, and resuming that from the Build with AI screen would publish the invention as
 * A's next version. That is #874 arriving by the back door, so a create always starts clean.
 */
export function needsFreshSession(mode: AiMode, hasSession: boolean): boolean {
  return mode === "create" && hasSession;
}

/** What a session was opened against — fixed for its whole life, server-side. */
export interface SessionBinding {
  /** The workflow it will save as the next version of, or "" for an unbound build. */
  workflowKey: string;
  /** The environment it generates in (provider keys, connections). */
  env: string | null;
}

/**
 * Has the canvas moved out from under the session?
 *
 * `needsFreshSession` covers the case the user asks for ("start a new one"); this covers the ones
 * they don't. `/app/canvas` is a SIBLING of `/app`, not a child, so `AppShell`'s
 * `${pathname}|${activeEnv}` key never remounts it — `openWorkflow` just rewrites `?key=`, and
 * `newWorkflow` reseeds the canvas in place. Both leave a session ref alive across a change of the
 * very thing it is bound to.
 *
 * WHY IT MATTERS. A turn always edits the graph the canvas sends, so the model does the right work
 * either way — but `applyTurn` writes the result onto a session still stamped with workflow A. That
 * session then reads "editing A" in the resume list, and resuming it from the Build with AI screen
 * publishes B's graph as A's next version. Same destination as #874, reached by standing still.
 *
 * TWO RULES, DELIBERATELY DIFFERENT.
 *
 *   - **Environment**: any change is stale. The session carries its own `environmentId` and the
 *     turn endpoint prefers it over the request's, so a session opened in sandbox keeps generating
 *     against sandbox's provider keys and connections however the env chip reads.
 *   - **Workflow**: only a BOUND session goes stale, and only against a different key. An unbound
 *     one is safe by construction — resuming it creates a new workflow rather than overwriting one
 *     — which is what lets a from-scratch chat survive its own bookkeeping: the create path blanks
 *     `workflowKey`, and saving the draft later fills it in, and neither is a reason to throw away
 *     the conversation that produced it.
 */
export function sessionBindingStale(
  bound: SessionBinding | null,
  canvas: SessionBinding,
): boolean {
  if (!bound) return false;
  if (bound.env !== canvas.env) return true;
  return bound.workflowKey !== "" && bound.workflowKey !== canvas.workflowKey;
}

/** Persisted turns → thread messages. Nothing is fabricated client-side: the assistant's summary,
 *  its cost and its quick replies are all written by the server after a successful turn. */
function turnsToMessages(s: BuilderSession): ChatMsg[] {
  return s.turns.map((t) => ({
    id: t.id,
    role: t.role === "assistant" ? "assistant" : "user",
    text: t.content,
    costUsd: t.costUsd,
    options: t.options ?? [],
  }));
}

export function useAiBuilder({
  nodes,
  graph,
  graphError,
  rfRef,
  keyParam,
  templateParam,
  savedKey,
  activeEnv,
  setNodes,
  setEdges,
  setName,
  setWorkflowKey,
  setVersion,
  setStatus,
  setSearchParams,
  onGraphPresented,
  onEditApplied,
}: {
  nodes: Node<NaaryData>[];
  /** The live-compiled canvas, or undefined while it doesn't compile. What an edit turn sends. */
  graph: GraphDef | undefined;
  /** Why it doesn't compile — shown instead of silently generating a replacement. */
  graphError: string | undefined;
  rfRef: RefObject<ReactFlowInstance<Node<NaaryData>, FlowEdge> | null>;
  keyParam: string | null;
  templateParam: string | null;
  /**
   * The SAVED workflow this canvas holds, or "" for an unsaved draft.
   *
   * Binds the session to that workflow, which matters only later: a session resumed from the Build
   * with AI screen saves as the next VERSION of what it is bound to, and an unbound one forks a
   * copy. Deliberately not `activeKey` (which falls back to a slug of the name) — that is a save
   * TARGET, and binding a session to a workflow that doesn't exist yet would be a claim about
   * someone else's future key.
   */
  savedKey: string;
  /** The active environment. A session generates in ONE — see sessionBindingStale. */
  activeEnv: string | null;
  setNodes: Dispatch<SetStateAction<Node<NaaryData>[]>>;
  setEdges: Dispatch<SetStateAction<FlowEdge[]>>;
  setName: Dispatch<SetStateAction<string>>;
  setWorkflowKey: Dispatch<SetStateAction<string>>;
  setVersion: Dispatch<SetStateAction<number | null>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setSearchParams: SetURLSearchParams;
  /**
   * A generation LANDED, so the graph now on the canvas is what was presented, not an edit of
   * it — the unsaved-changes guard re-baselines from it. Called only on success (see the call
   * site for why a failed stream must NOT re-baseline).
   */
  onGraphPresented: () => void;
  /**
   * An EDIT landed and the canvas now differs from the last saved version. Distinct from
   * `onGraphPresented`, which fires only for a CREATE — the two are mutually exclusive by
   * construction (see shouldRebaselineAfterGeneration), and conflating them is what would make the
   * review panel open on a draft that has nothing to compare against.
   */
  onEditApplied?: () => void;
}) {
  const [showAi, setShowAi] = useState(false);
  /** The composer draft. Controlled here because `?fix=` writes a description of a failed run into
   *  it and the user reads it before pressing Send (useFixFromRun). */
  const [aiPrompt, setAiPrompt] = useState("");
  // "edit" CHANGES what's on the canvas; "create" replaces it with a new draft. Chosen by the
  // user, never inferred from "the canvas has nodes" — starting over on a populated canvas is a
  // real thing to want, and guessing wrong either destroys work or refuses to.
  const [aiMode, setAiMode] = useState<AiMode>("create");
  // Editing needs something to edit. Offer it the moment the canvas compiles, and fall back
  // when it stops (deleting the last trigger mid-session must not leave a dead button).
  const canEdit = Boolean(graph);
  const mode: AiMode = canEdit ? aiMode : "create";
  useEffect(() => {
    // Default to editing on a canvas that already holds a workflow — the overwhelmingly more
    // common intent once something is there.
    if (canEdit) setAiMode("edit");
  }, [canEdit]);

  /* ---------------- conversation state ---------------- */

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [phase, setPhase] = useState<BuildPhase>("idle");
  const [typing, setTyping] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  /** The elements of the CURRENT turn, for the "Building" plan card (the canvas itself is drawn
   *  by `relayout` below — this is the textual account of the same frames). */
  const [streamNodes, setStreamNodes] = useState<NodeDef[]>([]);
  const [streamEdgeCount, setStreamEdgeCount] = useState(0);
  const [gotFrame, setGotFrame] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  /** What the live session was opened against — see sessionBindingStale. Null with no session. */
  const boundRef = useRef<SessionBinding | null>(null);
  /** Has this conversation ever produced a validated draft? A ref, not `messages.length`, because
   *  the failure path below reads it from inside a closure over an older render. */
  const hasDraftRef = useRef(false);
  const generating = phase === "streaming";

  // Playful rotating status while streaming, + how many nodes have landed on the canvas. Both feed
  // the canvas's own progress pill, which is what the user watches while the panel scrolls.
  const genMessage = useRotatingProgressMessage(generating);
  const [genNodeCount, setGenNodeCount] = useState(0);

  /* ---------------- provider (BYOK), shared with the Build with AI screen ---------------- */

  const { activeId: tenantId } = useWorkspace();
  const [credentials, setCredentials] = useState<
    { provider: string; isValid: boolean }[] | null
  >(null);
  const [provider, setProvider] = useState<AiBuilderProvider | null>(null);
  // `send` is re-created each render, but the SSE call outlives the render that started it — read
  // the selection from a ref so a turn always uses what was chosen, not what was chosen first.
  const providerRef = useRef<AiBuilderProvider | null>(null);
  providerRef.current = provider;
  const options = providerOptions(credentials);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api
      .listCredentials(tenantId)
      .then((rows) => {
        if (cancelled) return;
        setCredentials(rows);
        // Restore the remembered choice only if it's still usable — a credential removed since
        // would 400 on send, on a preference the user didn't re-make this time.
        setProvider(
          resolveStoredProvider(readStoredProvider(), providerOptions(rows)),
        );
      })
      // A failed credential list must not block generating: Auto still works, and the server
      // returns its own actionable error if nothing is configured.
      .catch(() => !cancelled && setCredentials([]));
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function chooseProvider(next: AiBuilderProvider | null) {
    setProvider(next);
    writeStoredProvider(next);
  }

  /* ---------------- effects that follow the stream ---------------- */

  // `fitView` (the prop) only fits ONCE at init. While streaming, refit as nodes land so
  // the growing graph stays in frame instead of marching off-screen. Debounced a beat so
  // the just-added node is measured first.
  useEffect(() => {
    if (!generating) return;
    const id = setTimeout(
      () => rfRef.current?.fitView({ duration: 250, padding: 0.25 }),
      70,
    );
    return () => clearTimeout(id);
  }, [nodes, generating, rfRef]);

  /* ---------------- the turn ---------------- */

  /**
   * Send one conversation turn.
   *
   * In "edit" mode the message is a CHANGE to the live canvas, whose identity is kept so Save
   * writes the workflow's next version. In "create" mode it describes a workflow to invent, which
   * replaces the canvas as a NEW unsaved draft — the same act as forking a template.
   */
  async function send(text: string) {
    const message = text.trim();
    if (!message || generating) return;
    // An edit needs a compilable canvas to send. Refuse with the compile error rather than fall
    // through to a create — silently generating a replacement for someone who asked for a change
    // is precisely the behaviour this panel exists not to have.
    if (mode === "edit" && !graph) {
      setChatError(
        `Can't change this workflow until the canvas is valid — ${graphError ?? "it doesn't compile yet"}`,
      );
      return;
    }
    const editing = mode === "edit" && graph !== undefined;

    // Two reasons to start over, checked together because they have the same consequence: the
    // session in hand can no longer stand for what the user is looking at. One is asked for
    // ("start a new one"); the other is what happens when the canvas is pointed at a different
    // workflow, or a different environment, without this screen ever remounting.
    if (
      needsFreshSession(mode, Boolean(sessionRef.current)) ||
      sessionBindingStale(boundRef.current, {
        workflowKey: savedKey,
        env: activeEnv,
      })
    ) {
      sessionRef.current = null;
      boundRef.current = null;
      hasDraftRef.current = false;
      setMessages([]);
    }

    setPhase("streaming");
    setTyping(true);
    setChatError(null);
    setGotFrame(false);
    setStreamNodes([]);
    setStreamEdgeCount(0);
    setGenNodeCount(0);
    setStatus(null);
    setDraftName(null);
    // The user turn is real — it is the message being sent, and the server persists it. Shown
    // immediately so the thread never sits empty while the first frame is in flight.
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", text: message },
    ]);
    // NOTE: the canvas is NOT cleared here — the first streamed node replaces it wholesale
    // (relayout rebuilds from the streamed nodes alone), so an error BEFORE any node arrives
    // leaves the user's current work intact (a transient 429 mustn't wipe the canvas).

    // Live accumulation of the streamed graph (raw GraphDef-shaped nodes/edges).
    type RawNode = GraphDef["nodes"][number];
    type RawEdge = GraphDef["edges"][number];
    const rawNodes: RawNode[] = [];
    const rawEdges: RawEdge[] = [];
    // Position bookkeeping (see stream-positions.ts): `place` holds nodes still mid-stream,
    // `settle` sends pre-existing nodes home at the end. Seeded from the canvas on an EDIT so
    // untouched nodes don't move — GraphDef carries no positions, so without this a faithful
    // edit re-lays-out the whole canvas and is indistinguishable from a rewrite. Empty on a
    // create: there's nothing to preserve.
    const positions = makeStreamPositions(
      editing
        ? nodes.map((n) => [n.id, { ...n.position }] as const)
        : undefined,
    );
    let startId: string | undefined;

    const relayout = () => {
      const known = new Set(rawNodes.map((n) => n.id));
      const partial: GraphDef = {
        startNodeId: startId ?? rawNodes[0]?.id ?? "",
        nodes: rawNodes,
        // Only wire edges whose BOTH endpoints have arrived (React Flow drops dangling ones).
        edges: rawEdges.filter((e) => known.has(e.from) && known.has(e.to)),
      };
      const { nodes: cn, edges: ce } = decompileGraph(partial);
      const stable = positions.place(cn);
      // `naary-node-enter` animates each node once on mount (React Flow keys by id, so
      // already-mounted nodes don't replay).
      setNodes(
        toFlowNodes(stable).map((fn) => ({
          ...fn,
          className: "naary-node-enter",
        })),
      );
      setEdges(toFlowEdges(ce));
    };

    try {
      let sid = sessionRef.current;
      if (!sid) {
        // Bound to the SAVED workflow when there is one, so a session resumed later from the
        // Build with AI screen saves as its next version rather than forking a copy (#874). A
        // create is never bound: it is about to invent a different workflow.
        const boundKey = editing && savedKey ? savedKey : "";
        const opened = await builderApi.openBuilderSession(
          boundKey ? { workflowKey: boundKey } : {},
        );
        sid = opened.id;
        sessionRef.current = sid;
        // Record what it was opened against, so a later turn can tell whether the canvas has since
        // moved out from under it.
        boundRef.current = { workflowKey: boundKey, env: activeEnv };
      }

      const result = await builderApi.sendBuilderTurn(
        sid,
        message,
        providerRef.current ?? undefined,
        {
          onMeta: (nm) => {
            setName(nm);
            setDraftName(nm);
          },
          onNode: (raw) => {
            const n = asNodeDef(raw);
            if (!n) return;
            if (rawNodes.some((x) => x.id === n.id)) return; // dedup by id
            if (rawNodes.length === 0) startId = n.id; // provisional entry = first node
            rawNodes.push(n as RawNode);
            setTyping(false);
            setGotFrame(true);
            setGenNodeCount(rawNodes.length);
            setStreamNodes([...rawNodes] as NodeDef[]);
            relayout();
          },
          onEdge: (raw) => {
            const e = asEdgeDef(raw);
            if (!e) return;
            const dup = rawEdges.some(
              (x) =>
                x.from === e.from &&
                x.to === e.to &&
                JSON.stringify(x.condition) === JSON.stringify(e.condition),
            );
            if (dup) return;
            rawEdges.push(e as RawEdge);
            setTyping(false);
            setGotFrame(true);
            setStreamEdgeCount(rawEdges.length);
            relayout();
          },
        },
        // The graph this turn edits: the LIVE canvas, hand-edits included. Undefined on a create,
        // where a fresh session has no draft and the model is being asked to invent one.
        editing ? graph : undefined,
      );

      // Reconcile to the authoritative validated graph — final positions + wiring, no
      // enter-animation className (the nodes are already mounted). `settle` puts surviving
      // nodes back where they were — an edit must not relocate what it didn't change — while
      // anything NEW takes this layout, computed over the whole finished graph.
      const { nodes: cn, edges: ce } = decompileGraph(result.graph);
      setNodes(toFlowNodes(positions.settle(cn)));
      setEdges(toFlowEdges(ce));
      setName(result.name);
      setDraftName(result.name);
      setStreamNodes(result.graph.nodes);
      setStreamEdgeCount(result.graph.edges.length);
      // Whether this landing becomes the guard's new baseline — see the predicate for why an EDIT
      // must not. Called on the SUCCESS path, after the reconcile, and not on the falling edge of
      // `generating`: a turn that dies mid-stream leaves a half-drawn graph on the canvas, and
      // baselining THAT would mark the user's real unsaved edits clean.
      if (shouldRebaselineAfterGeneration(editing ? "edit" : "create")) {
        onGraphPresented();
      }
      if (editing) {
        // Keep workflowKey + version: this is the SAME workflow, so Save writes its next version.
        // Blanking them (what the create path does) forks a copy and orphans the original — the
        // run history, schedules and webhook URLs all stay behind on it.
        setStatus("Updated — review the changes and Save to keep them.");
        onEditApplied?.();
      } else {
        setWorkflowKey(""); // now a NEW unsaved draft (only after a successful turn)
        setVersion(null);
        if (keyParam || templateParam) setSearchParams({}, { replace: true });
        setStatus("Generated — review, edit, and Save to keep it.");
        // The canvas was already compilable before this, so the canEdit effect won't refire and
        // the mode would stay "create" — making the natural follow-up ("now add an approval step")
        // replace the thing just built. Generate-then-refine is the common path; hand it back in
        // edit mode.
        setAiMode("edit");
      }
      // Pull the persisted turns — the server writes the assistant's change-summary, its metered
      // BYOK cost and its quick replies, and none of those may be invented here.
      let persisted: ChatMsg[] | null = null;
      try {
        persisted = turnsToMessages(await builderApi.getBuilderSession(sid));
      } catch {
        /* thread refresh failed — keep the optimistic user turn; the plan card already shows the
           build completed. No fabricated assistant text. */
      }
      if (persisted) setMessages(persisted);
      hasDraftRef.current = true;
      setPhase("ready");
      setTyping(false);
      // The refit effect stops once `generating` flips false (same render as this reconcile), so
      // fit to the final graph explicitly.
      setTimeout(
        () => rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
        80,
      );
    } catch (e) {
      setTyping(false);
      // Back to `ready` if this conversation has already produced a draft, so the thread doesn't
      // fall back to the intro and lose it; `idle` if the very first turn failed.
      setPhase(hasDraftRef.current ? "ready" : "idle");
      setChatError(
        e instanceof Error
          ? e.message
          : editing
            ? "Couldn't apply that change."
            : "Couldn't build that. Make sure an AI provider is connected (Integrations).",
      );
    } finally {
      setGenNodeCount(0);
    }
  }

  /** "New chat" — start the conversation over. The old session stays open server-side (it is
   *  resumable from the Build with AI screen); the canvas is untouched, because the workflow on it
   *  is the user's, not the conversation's. */
  function resetChat() {
    sessionRef.current = null;
    boundRef.current = null;
    hasDraftRef.current = false;
    setMessages([]);
    setPhase("idle");
    setTyping(false);
    setChatError(null);
    setStreamNodes([]);
    setStreamEdgeCount(0);
    setGotFrame(false);
    setDraftName(null);
    setAiPrompt("");
  }

  const plan =
    gotFrame || phase === "ready"
      ? planFromStream(
          draftName,
          streamNodes,
          streamEdgeCount,
          phase === "ready",
        )
      : null;

  return {
    showAi,
    setShowAi,
    aiPrompt,
    setAiPrompt,
    aiMode: mode,
    setAiMode,
    canEdit,
    generating,
    genMessage,
    genNodeCount,
    // conversation
    messages,
    phase,
    typing,
    plan,
    chatError,
    send,
    resetChat,
    // provider (BYOK)
    provider,
    chooseProvider,
    providerOptions: options,
    providerHint: providerSetupHint(options),
  };
}
