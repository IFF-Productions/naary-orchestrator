// Inspector-dock read-models (extracted verbatim from CanvasPage): the selected node's
// resolved label, its INPUT DATA rows (upstream fresh/pinned outputs), and the ROUTING
// RULES view for switch/if nodes. Pure inputs → derived outputs; no local state.
import { useCallback, useMemo } from "react";
import { type Node } from "@xyflow/react";
import { nodeDisplayLabel } from "../../lib/graph-model";
import type { NodeTestRun } from "./canvas-types";
import { type FlowEdge, type NaaryData } from "./flow";
import { upstreamOf } from "./graph-traversal";
import { type DockInputRow, type DockRoutingRow } from "./InspectorDock";
import { flattenOutput } from "./output-fields";

export function useDockDerivations({
  nodes,
  edges,
  nodeRuns,
  pins,
  selected,
}: {
  nodes: Node<NaaryData>[];
  edges: FlowEdge[];
  nodeRuns: Record<string, NodeTestRun>;
  pins: Record<string, unknown>;
  selected: Node<NaaryData> | undefined;
}) {
  const nodeLabelOf = useCallback(
    (id: string): string => {
      const n = nodes.find((x) => x.id === id);
      return n ? nodeDisplayLabel(n.data.kind, n.data.config) : id;
    },
    [nodes],
  );

  // INPUT DATA: the selected node's REAL available inputs — every upstream node's
  // fresh test output, else its pinned sample. Source tag = the node's name; pinned
  // samples are tagged "pinned" (per the design comp).
  const dockInputRows = useMemo((): DockInputRow[] => {
    if (!selected) return [];
    const rows: DockInputRow[] = [];
    for (const uid of upstreamOf(selected.id, edges)) {
      const run = nodeRuns[uid];
      const fresh =
        run?.status === "done" && run.output !== undefined && !run.stale;
      const src = fresh
        ? run.output
        : Object.hasOwn(pins, uid)
          ? pins[uid]
          : undefined;
      if (src === undefined) continue;
      const tag = fresh ? nodeLabelOf(uid) : "pinned";
      for (const f of flattenOutput(src, "", 0, [], 8)) {
        rows.push({
          key: `${uid}.${f.path}`,
          token: `{{ ${uid}.${f.path} }}`,
          path: f.path,
          preview: f.preview,
          tag,
        });
        if (rows.length >= 40) return rows;
      }
    }
    return rows;
  }, [selected, edges, nodeRuns, pins, nodeLabelOf]);

  // ROUTING RULES read-view (switch/if) — derived from the REAL config + edges.
  // Switch: rules run top-to-bottom (first match wins) and set `<id>.matched`;
  // MATCHED/SKIPPED badges appear only when a real test output states which rule
  // matched. If: each outgoing edge is its own branch (every matching edge fires).
  const dockRouting = useMemo((): {
    rows: DockRoutingRow[];
    title: string;
    note: string;
  } | null => {
    if (!selected) return null;
    const kind = selected.data.kind;
    if (kind !== "switch" && kind !== "if") return null;
    const outs = edges.filter((e) => e.source === selected.id);
    const fmt = (c?: {
      path?: string;
      op?: string;
      value?: unknown;
    }): string => {
      if (!c?.path?.trim()) return "always";
      if (c.op === "exists") return `${c.path} exists`;
      const v = typeof c.value === "string" ? c.value : JSON.stringify(c.value);
      return `${c.path} ${c.op ?? "eq"} ${v ?? ""}`.trim();
    };
    if (kind === "if") {
      if (outs.length === 0) return null;
      return {
        rows: outs.map((e, i) => ({
          n: i + 1,
          cond: fmt(e.data?.condition),
          target: nodeLabelOf(e.target),
        })),
        title: "Branches · every matching edge fires",
        note: "Each outgoing edge is taken when its condition holds; unconditional edges always fire.",
      };
    }
    // switch — rules from the node's real config; targets from real edges that
    // branch on `matched eq <name>`.
    const cfg = selected.data.config ?? {};
    const rules =
      (cfg.rules as
        | {
            name?: string;
            condition?: { path?: string; op?: string; value?: unknown };
          }[]
        | undefined) ?? [];
    if (rules.length === 0) return null;
    const fallback =
      typeof cfg.fallback === "string" ? cfg.fallback : "default";
    const run = nodeRuns[selected.id];
    const out =
      run?.status === "done" && !run.stale && run.output
        ? (run.output as Record<string, unknown>)
        : undefined;
    const matched =
      out && typeof out.matched === "string" ? out.matched : undefined;
    const targetFor = (ruleName?: string): string | undefined => {
      if (!ruleName) return undefined;
      const e = outs.find((x) => {
        const c = x.data?.condition;
        return (
          c &&
          /(^|\.)matched$/.test(c.path ?? "") &&
          c.op === "eq" &&
          String(c.value) === ruleName
        );
      });
      return e ? nodeLabelOf(e.target) : undefined;
    };
    const badge = (ruleName: string): "matched" | "skipped" | undefined =>
      matched === undefined
        ? undefined
        : matched === ruleName
          ? "matched"
          : "skipped";
    const rows: DockRoutingRow[] = rules.map((r, i) => ({
      n: i + 1,
      cond: fmt(r.condition),
      target: targetFor(r.name),
      badge: r.name ? badge(r.name) : undefined,
    }));
    rows.push({
      n: rules.length + 1,
      cond: `else (${fallback})`,
      target: targetFor(fallback),
      badge: badge(fallback),
    });
    return {
      rows,
      title: "Routing rules · first match wins",
      note: `The first matching rule sets ${selected.id}.matched to its name; outgoing edges branch on it (matched eq <name>).`,
    };
  }, [selected, edges, nodeRuns, nodeLabelOf]);

  return { nodeLabelOf, dockInputRows, dockRouting };
}
