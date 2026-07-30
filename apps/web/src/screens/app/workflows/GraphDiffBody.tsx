/**
 * The PRESENTATION of a `GraphDiff` — the +/~/− rows, and the summary counts — with no opinion
 * about where the diff came from.
 *
 * Extracted from `DiffModal`, which computed its diff by fetching two saved VERSIONS from the
 * server. That coupling is exactly what made it unusable for the other place a diff belongs: the
 * canvas, reviewing an unsaved AI edit against the graph it started from. `diffGraphs` is pure and
 * runs happily in the browser, so the only thing standing in the way was that the rendering lived
 * inside a modal that also owned pickers, a fetch, and a version-history contract.
 *
 * So: this file renders a diff someone else computed. `DiffModal` stays the version-comparison
 * screen and becomes a consumer; the canvas's review panel becomes a second one.
 */
import type { GraphDiff, NodeType } from "@naary/dsl";
import { Icon, type IconName } from "../../../components";
import { ACCENT, nodeDisplayLabel } from "../../../lib/graph-model";
import { nodeIcon } from "./model";

type DiffNode = GraphDiff["nodesAdded"][number];
type DiffEdge = GraphDiff["edgesAdded"][number];

type Kind = "add" | "chg" | "del" | "info";

const TINT: Record<Kind, string> = {
  add: "var(--state-done)",
  chg: "var(--state-paused)",
  del: "var(--state-error)",
  info: "var(--ink-3)",
};
const SIGN: Record<Kind, string> = { add: "+", chg: "~", del: "−", info: "·" };
const TAG: Record<Kind, string> = {
  add: "added",
  chg: "changed",
  del: "removed",
  info: "",
};

export function DiffRow({
  kind,
  icon,
  accent,
  name,
  detail,
  tag,
}: {
  kind: Kind;
  icon: IconName;
  accent: string;
  name: string;
  detail?: string;
  tag?: string;
}) {
  const fg = TINT[kind];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: `1px solid color-mix(in srgb, ${fg} 35%, transparent)`,
        background:
          kind === "info"
            ? "var(--card)"
            : `color-mix(in srgb, ${fg} 8%, var(--card))`,
        borderRadius: 11,
        padding: "11px 13px",
      }}
    >
      <span
        className="mono"
        style={{
          width: 20,
          height: 20,
          flex: "none",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--text-body)",
          fontWeight: "var(--weight-bold)",
          color: fg,
          border: `1px solid color-mix(in srgb, ${fg} 40%, transparent)`,
        }}
      >
        {SIGN[kind]}
      </span>
      <span
        style={{
          width: 30,
          height: 30,
          flex: "none",
          borderRadius: 8,
          border: `1px solid ${accent}`,
          color: accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          {name}
        </div>
        {detail && (
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detail}
          </div>
        )}
      </div>
      {(tag ?? TAG[kind]) && (
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-bold)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: fg,
            flex: "none",
          }}
        >
          {tag ?? TAG[kind]}
        </span>
      )}
    </div>
  );
}

const nodeName = (n: DiffNode): string =>
  nodeDisplayLabel(n.type as NodeType, n.config);
const edgeName = (e: DiffEdge): string => `${e.from} → ${e.to}`;
const edgeDetail = (e: DiffEdge): string | undefined =>
  e.condition ? `when ${e.condition.path} ${e.condition.op}` : undefined;

/** Nothing structural changed. Exported so callers can offer their own wording for it. */
export function isEmptyDiff(d: GraphDiff): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    !d.edgesReordered &&
    !d.startNodeChanged
  );
}

/** How many of each — the footer summary, and a caller's "N changes" badge. */
export function diffCounts(d: GraphDiff): {
  add: number;
  chg: number;
  del: number;
  total: number;
} {
  const add = d.nodesAdded.length + d.edgesAdded.length;
  const chg =
    d.nodesChanged.length +
    (d.startNodeChanged ? 1 : 0) +
    (d.edgesReordered ? 1 : 0);
  const del = d.nodesRemoved.length + d.edgesRemoved.length;
  return { add, chg, del, total: add + chg + del };
}

/**
 * Every change in the diff, as rows. Renders NOTHING when the diff is empty — a caller says what
 * "no changes" means in its own context ("no structural changes between these versions" is not
 * the same sentence as "the edit changed nothing"), so the wording stays with them.
 */
export function GraphDiffBody({ diff }: { diff: GraphDiff }) {
  if (isEmptyDiff(diff)) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {diff.nodesAdded.map((n) => (
        <DiffRow
          key={`na-${n.id}`}
          kind="add"
          icon={nodeIcon(n.type as NodeType)}
          accent={ACCENT[n.type as NodeType] ?? "var(--ink-2)"}
          name={nodeName(n)}
          detail={n.id}
        />
      ))}
      {diff.nodesChanged.map((c) => (
        <DiffRow
          key={`nc-${c.id}`}
          kind="chg"
          icon={nodeIcon(c.after.type as NodeType)}
          accent={ACCENT[c.after.type as NodeType] ?? "var(--ink-2)"}
          name={nodeName(c.after)}
          detail={`${c.id} · ${c.fields.join(", ")}`}
        />
      ))}
      {diff.nodesRemoved.map((n) => (
        <DiffRow
          key={`nr-${n.id}`}
          kind="del"
          icon={nodeIcon(n.type as NodeType)}
          accent={ACCENT[n.type as NodeType] ?? "var(--ink-2)"}
          name={nodeName(n)}
          detail={n.id}
        />
      ))}
      {diff.edgesAdded.map((e, i) => (
        <DiffRow
          key={`ea-${i}-${e.from}-${e.to}`}
          kind="add"
          icon="arrow-right"
          accent="var(--ink-2)"
          name={edgeName(e)}
          detail={edgeDetail(e)}
          tag="edge added"
        />
      ))}
      {diff.edgesRemoved.map((e, i) => (
        <DiffRow
          key={`er-${i}-${e.from}-${e.to}`}
          kind="del"
          icon="arrow-right"
          accent="var(--ink-2)"
          name={edgeName(e)}
          detail={edgeDetail(e)}
          tag="edge removed"
        />
      ))}
      {diff.startNodeChanged && (
        <DiffRow
          kind="chg"
          icon="bolt"
          accent="var(--node-trigger)"
          name="Entry node changed"
          detail="the workflow now starts from a different node"
        />
      )}
      {/* Edge ORDER is semantically significant — the interpreter takes the first matching
          outgoing edge — so a pure reorder is a real behaviour change, not cosmetic. */}
      {diff.edgesReordered && (
        <DiffRow
          kind="chg"
          icon="router"
          accent="var(--node-router)"
          name="Edges reordered"
          detail="affects branch precedence"
        />
      )}
    </div>
  );
}

/** The `+N added · ~N changed · −N removed` summary line. */
export function GraphDiffCounts({ diff }: { diff: GraphDiff }) {
  const counts = diffCounts(diff);
  const cell = (color: string, sign: string, n: number, label: string) => (
    <span>
      <span style={{ color, fontWeight: "var(--weight-semibold)" }}>
        {sign}
        {n}
      </span>{" "}
      {label}
    </span>
  );
  return (
    <div
      style={{
        fontSize: "var(--text-xs)",
        color: "var(--ink-faint)",
        display: "flex",
        gap: 14,
      }}
    >
      {cell("var(--state-done)", "+", counts.add, "added")}
      {cell("var(--state-paused)", "~", counts.chg, "changed")}
      {cell("var(--state-error)", "−", counts.del, "removed")}
    </div>
  );
}
