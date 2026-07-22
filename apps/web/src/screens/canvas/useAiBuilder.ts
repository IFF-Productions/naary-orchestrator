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

export function useAiBuilder({
  nodes,
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
}: {
  nodes: Node<NaaryData>[];
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
}) {
  // AI workflow builder: describe a flow → generate a draft onto the canvas.
  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  // "" = let the server auto-pick the tenant's configured provider.
  const [genProvider, setGenProvider] = useState("");
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

  // Generate a draft graph from the description and load it onto the canvas as a
  // NEW unsaved draft (same as forking a template — Save persists it). The API-model
  // path STREAMS: each node/edge is drawn live as it's generated (with a fade/scale-in),
  // then the whole canvas is reconciled to the authoritative validated graph on `result`.
  async function generateFromPrompt() {
    const prompt = aiPrompt.trim();
    if (!prompt || generating) return;
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
    // Keep already-placed node positions STABLE so siblings don't jump as new nodes
    // arrive (the authoritative re-layout happens once, on `result`).
    const placed = new Map<string, { x: number; y: number }>();
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
      const stable = cn.map((n) => {
        const pos = placed.get(n.id) ?? n.position;
        placed.set(n.id, pos);
        return { ...n, position: pos };
      });
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
      );
      // Reconcile to the authoritative validated graph — final positions + wiring, no
      // enter-animation className (the nodes are already mounted).
      const { nodes: cn, edges: ce } = decompileGraph(gen);
      setNodes(toFlowNodes(cn));
      setEdges(toFlowEdges(ce));
      setName(genName);
      setWorkflowKey(""); // now a NEW unsaved draft (only after a successful generation)
      setVersion(null);
      if (keyParam || templateParam) setSearchParams({}, { replace: true });
      setStatus("Generated — review, edit, and Save to keep it.");
      // The generating effect stops refitting once `generating` flips false (same render
      // as this reconcile), so fit to the final graph explicitly.
      setTimeout(
        () => rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
        80,
      );
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Couldn't generate a workflow.",
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
    generating,
    genMessage,
    genNodeCount,
    generateFromPrompt,
  };
}
