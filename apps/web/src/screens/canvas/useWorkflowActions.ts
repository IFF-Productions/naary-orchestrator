// Workflow persistence + file IO handlers (extracted verbatim from CanvasPage): export the
// compiled graph to JSON, import a graph JSON as a new draft, and the save / run / save-only
// paths. Plain handlers closing over the page's state setters — no hooks of their own.
import { type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { type Node } from "@xyflow/react";
import type { NavigateFunction, SetURLSearchParams } from "react-router-dom";
import { type GraphDef } from "@naary/dsl";
import { api, type GraphSummary, UnauthorizedError } from "../../lib/api";
import { withReturn } from "../../lib/canvas-return";
import { decompileGraph } from "../../lib/decompile-graph";
import { type CanvasBaseline, savedWorkflowName } from "./canvas-dirty";
import {
  type FlowEdge,
  type NaaryData,
  slugify,
  toFlowEdges,
  toFlowNodes,
} from "./flow";

export function useWorkflowActions({
  graph,
  error,
  name,
  activeKey,
  showInput,
  runInput,
  keyParam,
  templateParam,
  returnTo,
  setNodes,
  setEdges,
  setName,
  setWorkflowKey,
  setVersion,
  setStatus,
  setBusy,
  setWorkflows,
  setSearchParams,
  navigate,
  onSaved,
  onGraphReplaced,
}: {
  graph: GraphDef | undefined;
  error: string | undefined;
  name: string;
  activeKey: string;
  showInput: boolean;
  runInput: string;
  keyParam: string | null;
  templateParam: string | null;
  /** The canvas's validated return target, preserved across param rewrites. */
  returnTo: string | null;
  setNodes: Dispatch<SetStateAction<Node<NaaryData>[]>>;
  setEdges: Dispatch<SetStateAction<FlowEdge[]>>;
  setName: Dispatch<SetStateAction<string>>;
  setWorkflowKey: Dispatch<SetStateAction<string>>;
  setVersion: Dispatch<SetStateAction<number | null>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setWorkflows: Dispatch<SetStateAction<GraphSummary[]>>;
  setSearchParams: SetURLSearchParams;
  navigate: NavigateFunction;
  /**
   * A save landed: this exact graph + name is now what's persisted, and so the new baseline for
   * the unsaved-changes guard. Handed the saved values rather than letting the guard re-derive
   * them, so "what we sent" and "what we compare against" cannot drift.
   */
  onSaved: (saved: CanvasBaseline) => void;
  /** A different graph was PRESENTED (imported) — drop the baseline, don't diff against it. */
  onGraphReplaced: () => void;
}) {
  // Export the current (valid) graph as a portable JSON file — the same GraphDef the API
  // stores, wrapped with the display name so an import round-trips. Invalid graphs can't be
  // exported (nothing runnable to serialize) — the reason is surfaced instead.
  function exportGraph() {
    if (!graph) {
      setStatus(error ?? "Fix the graph's issues before exporting.");
      return;
    }
    // One resolved name drives the payload name AND the status message (they always match).
    // The FILENAME is its slug — a filesystem-safe form that can differ from the display name
    // (e.g. "My Flow" → my-flow.json, or "---" → the DEFAULT_KEY fallback), which is expected.
    const exportName = name.trim() || "workflow";
    const exportSlug = slugify(exportName);
    const payload = { naaryFlow: 1, name: exportName, graph };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportSlug}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation — revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Exported "${exportName}".`);
  }

  // Import a graph JSON (raw GraphDef or a { name, graph } export) as a NEW unsaved draft —
  // mirrors the generate/template path (decompile → editable flow), so Save persists a new
  // workflow rather than overwriting whatever was open.
  function importFromFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () =>
      setStatus("Import failed — the file couldn't be read.");
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setStatus("Import failed — the file isn't valid JSON.");
        return;
      }
      const wrapper =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      const gd = ("graph" in wrapper ? wrapper.graph : parsed) as {
        nodes?: unknown;
        edges?: unknown;
        startNodeId?: unknown;
      };
      // decompileGraph maps graph.nodes AND graph.edges → both must be arrays, plus a start id.
      if (
        !gd ||
        typeof gd !== "object" ||
        !Array.isArray(gd.nodes) ||
        !Array.isArray(gd.edges) ||
        typeof gd.startNodeId !== "string"
      ) {
        setStatus(
          "Import failed — not a Naary graph (needs nodes[], edges[], startNodeId).",
        );
        return;
      }
      try {
        const { nodes: cn, edges: ce } = decompileGraph(gd as GraphDef);
        setNodes(toFlowNodes(cn));
        setEdges(toFlowEdges(ce));
      } catch {
        setStatus(
          "Import failed — the graph couldn't be loaded onto the canvas.",
        );
        return;
      }
      // Resolve the applied name ONCE (wrapper name → filename → fallback) so the name set on
      // state and the name shown in the status message can't diverge on an empty edge case.
      const fromWrapper =
        typeof wrapper.name === "string" && wrapper.name.trim()
          ? wrapper.name
          : file.name.replace(/\.json$/i, "");
      const appliedName = fromWrapper.trim() || "Imported workflow";
      setName(appliedName);
      setWorkflowKey("");
      setVersion(null);
      // The imported graph is what's now on screen, not an edit of what was there — re-baseline
      // the unsaved-changes guard so an untouched import doesn't read as work in progress.
      onGraphReplaced();
      // Clearing ?key=/?template= must NOT clear the canvas's return target — a fresh params
      // object would drop it and strand the user's "back" on /app (see lib/canvas-return).
      if (keyParam || templateParam)
        setSearchParams(withReturn({}, returnTo), { replace: true });
      setStatus(`Imported "${appliedName}" — review, then Save to keep it.`);
    };
    reader.readAsText(file);
  }

  async function save(): Promise<string | null> {
    if (!graph) {
      setStatus(error ?? "Graph is not runnable.");
      return null;
    }
    const key = activeKey;
    // Resolved ONCE: the name we persist is also the name the unsaved-changes guard baselines
    // against, so a blank title can't come back as "renamed" the moment it's saved.
    const savedAs = savedWorkflowName(name);
    const saved = await api.saveGraph(key, savedAs, graph);
    setWorkflowKey(key);
    setVersion(saved.version);
    onSaved({ graph, name: savedAs });
    api
      .listGraphs()
      .then(setWorkflows)
      .catch(() => {});
    return key;
  }

  async function run() {
    // Parse the optional run input BEFORE any save, so a malformed payload doesn't
    // mutate state. Blank ⇒ undefined (server uses the Start node's sampleInput).
    let input: Record<string, unknown> | undefined;
    if (showInput && runInput.trim()) {
      try {
        const parsed = JSON.parse(runInput);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setStatus("Run input must be a JSON object.");
          return;
        }
        input = parsed as Record<string, unknown>;
      } catch {
        setStatus("Run input is not valid JSON.");
        return;
      }
    }
    setBusy(true);
    setStatus(null);
    try {
      const key = await save();
      if (!key) return;
      const { workflowId } = await api.startExecution(key, input);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        navigate("/auth");
        return;
      }
      setStatus(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveOnly() {
    setBusy(true);
    setStatus(null);
    try {
      const key = await save();
      if (key) setStatus(`Saved as "${name}" (${key}).`);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        navigate("/auth");
        return;
      }
      setStatus(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return { exportGraph, importFromFile, save, run, saveOnly };
}
