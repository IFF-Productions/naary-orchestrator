// AI workflow builder (extracted verbatim from CanvasPage): the describe-a-flow panel state,
// its playful streaming status + live-refit effects, and the streaming generate handler that
// draws each node/edge onto the canvas as it arrives, then reconciles to the validated graph.
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useState,
} from "react";
import { type Node, type ReactFlowInstance } from "@xyflow/react";
import type { SetURLSearchParams } from "react-router-dom";
import { type GraphDef } from "@naary/dsl";
import { api } from "../../lib/api";
import { decompileGraph } from "../../lib/decompile-graph";
import {
  nextProgressMessage,
  PROGRESS_MESSAGES,
} from "../../lib/progress-messages";
import {
  type FlowEdge,
  type NaaryData,
  toFlowEdges,
  toFlowNodes,
} from "./flow";
import { makeStreamPositions } from "./stream-positions";

/** What the panel does with what's already on the canvas: change it, or replace it. */
export type AiMode = "edit" | "create";

export function useAiBuilder({
  nodes,
  graph,
  graphError,
  rfRef,
  keyParam,
  templateParam,
  setNodes,
  setEdges,
  setName,
  setWorkflowKey,
  setVersion,
  setStatus,
  setSearchParams,
  onGraphPresented,
}: {
  nodes: Node<NaaryData>[];
  /** The live-compiled canvas, or undefined while it doesn't compile. What an edit sends. */
  graph: GraphDef | undefined;
  /** Why it doesn't compile — shown instead of silently generating a replacement. */
  graphError: string | undefined;
  rfRef: RefObject<ReactFlowInstance<Node<NaaryData>, FlowEdge> | null>;
  keyParam: string | null;
  templateParam: string | null;
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
}) {
  // AI workflow builder: describe a flow → generate a draft onto the canvas.
  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  // "" = let the server auto-pick the tenant's configured provider.
  const [genProvider, setGenProvider] = useState("");
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
  const [generating, setGenerating] = useState(false);
  // Playful rotating status while streaming, + how many nodes have landed on the canvas.
  const [genMessage, setGenMessage] = useState<string>(PROGRESS_MESSAGES[0]);
  const [genNodeCount, setGenNodeCount] = useState(0);

  // Rotate the playful message on a ~2.5s timer while generating (no immediate repeat).
  useEffect(() => {
    if (!generating) return;
    setGenMessage((prev) => nextProgressMessage(prev));
    const id = setInterval(
      () => setGenMessage((prev) => nextProgressMessage(prev)),
      2500,
    );
    return () => clearInterval(id);
  }, [generating]);

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

  // Run the panel: in "create" mode, draft a workflow from the description and load it as a
  // NEW unsaved draft (same as forking a template — Save persists it); in "edit" mode, apply
  // the description as a CHANGE to what's on the canvas, keeping the workflow's identity so
  // Save writes the next version of it rather than forking a copy. The API-model path STREAMS:
  // each node/edge is drawn live as it's generated (with a fade/scale-in), then the whole canvas
  // is reconciled to the authoritative validated graph on `result`.
  async function generateFromPrompt() {
    const prompt = aiPrompt.trim();
    if (!prompt || generating) return;
    // An edit needs a compilable canvas to send. Refuse with the compile error rather than
    // fall through to a create — silently generating a replacement for someone who asked for
    // a change is precisely the behaviour being fixed here.
    if (mode === "edit" && !graph) {
      setStatus(
        `Can't change this workflow until the canvas is valid — ${graphError ?? "it doesn't compile yet"}`,
      );
      return;
    }
    const editing = mode === "edit" && graph !== undefined;
    setGenerating(true);
    setGenNodeCount(0);
    setStatus(null);
    setShowAi(false); // reveal the canvas so the workflow appears live as it's built
    // NOTE: we do NOT clear the canvas here — the first streamed node replaces it
    // wholesale (relayout rebuilds from the streamed nodes alone), so an error BEFORE
    // any node arrives leaves the user's current work intact (a transient 429 mustn't
    // wipe the canvas). The prior graph + the pill show during the pre-first-token gap.

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
      const { name: genName, graph: gen } = await api.generateGraphStream(
        prompt,
        genProvider || undefined,
        {
          onMeta: (nm) => setName(nm),
          onNode: (node) => {
            const n = node as Partial<RawNode> | null;
            if (!n || typeof n.id !== "string" || typeof n.type !== "string")
              return;
            if (rawNodes.some((x) => x.id === n.id)) return; // dedup by id
            if (rawNodes.length === 0) startId = n.id; // provisional entry = first node
            rawNodes.push(n as RawNode);
            setGenNodeCount(rawNodes.length);
            relayout();
          },
          onEdge: (edge) => {
            const e = edge as Partial<RawEdge> | null;
            if (!e || typeof e.from !== "string" || typeof e.to !== "string")
              return;
            const dup = rawEdges.some(
              (x) =>
                x.from === e.from &&
                x.to === e.to &&
                JSON.stringify(x.condition) === JSON.stringify(e.condition),
            );
            if (dup) return;
            rawEdges.push(e as RawEdge);
            relayout();
          },
        },
        editing ? graph : undefined,
      );
      // Reconcile to the authoritative validated graph — final positions + wiring, no
      // enter-animation className (the nodes are already mounted). `settle` puts surviving
      // nodes back where they were — an edit must not relocate what it didn't change — while
      // anything NEW takes this layout, computed over the whole finished graph.
      const { nodes: cn, edges: ce } = decompileGraph(gen);
      setNodes(toFlowNodes(positions.settle(cn)));
      setEdges(toFlowEdges(ce));
      setName(genName);
      // A completed generation PRESENTS a graph rather than editing one, so it becomes the
      // unsaved-changes guard's new baseline. Here — on the SUCCESS path, after the reconcile —
      // and not on the falling edge of `generating`: a generation that dies mid-stream leaves a
      // half-drawn graph on the canvas, and baselining THAT would mark the user's real unsaved
      // edits clean and let them be discarded without a prompt.
      onGraphPresented();
      if (editing) {
        // Keep workflowKey + version: this is the SAME workflow, so Save writes its next
        // version. Blanking them (what the create path does) forks a copy and orphans the
        // original — the run history, schedules and webhook URLs all stay behind on it.
        setStatus("Updated — review the changes and Save to keep them.");
      } else {
        setWorkflowKey(""); // now a NEW unsaved draft (only after a successful generation)
        setVersion(null);
        if (keyParam || templateParam) setSearchParams({}, { replace: true });
        setStatus("Generated — review, edit, and Save to keep it.");
        // The canvas was already compilable before this, so the canEdit effect won't refire
        // and the mode would stay "create" — making the natural follow-up ("now add an
        // approval step") replace the thing just generated. Generate-then-refine is the
        // common path; hand it back in edit mode.
        setAiMode("edit");
      }
      // The generating effect stops refitting once `generating` flips false (same render
      // as this reconcile), so fit to the final graph explicitly.
      setTimeout(
        () => rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
        80,
      );
    } catch (e) {
      setStatus(
        e instanceof Error
          ? e.message
          : editing
            ? "Couldn't apply that change."
            : "Couldn't generate a workflow.",
      );
    } finally {
      setGenerating(false);
      setGenNodeCount(0);
    }
  }

  return {
    showAi,
    setShowAi,
    aiPrompt,
    setAiPrompt,
    genProvider,
    setGenProvider,
    aiMode: mode,
    setAiMode,
    canEdit,
    generating,
    genMessage,
    genNodeCount,
    generateFromPrompt,
  };
}
