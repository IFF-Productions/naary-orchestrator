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
 *
 * ONE TILE PER THING THAT CHANGED — and for a node, that means one tile per NODE (#1020).
 *
 * A reviewer scans this to decide whether to promote, and the unit they reason about is "which
 * nodes am I changing". So the tile count must equal the count of things affected: a node with
 * three edited config fields is ONE tile listing three changes inside it, never three tiles. The
 * obvious rendering of a field-level diff — map over the per-field changes and emit a row each —
 * would make this WORSE than the `pagerduty · config` line it replaces, because a heavily edited
 * node would flood the review and bury the node that changed once.
 *
 * What can co-occur, and where each lands:
 *   - a node changed in N ways      → 1 tile (the `details` list inside it)
 *   - a node added/removed          → 1 tile; it can't also be in nodesChanged
 *   - an EDGE added/removed/changed → 1 tile for the EDGE. An edge belongs to neither endpoint, so
 *                                     attributing it to a node would either duplicate it under both
 *                                     or hide it under an arbitrary one. It gets its own row,
 *                                     named `from → to`.
 *   - the entry node moved          → 1 tile. It's a graph-level fact, not a property of a node.
 * A node that changed AND sits on a changed edge therefore shows one node tile plus one edge tile,
 * which is two DIFFERENT changes, not the same change twice.
 */
import type { ReactNode } from "react";
import type { FieldChange, GraphDiff, NodeType } from "@naary/dsl";
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
  children,
}: {
  kind: Kind;
  icon: IconName;
  accent: string;
  name: string;
  detail?: string;
  tag?: string;
  /** The per-field breakdown, rendered INSIDE this tile — see the module header's one-tile rule. */
  children?: ReactNode;
}) {
  const fg = TINT[kind];
  return (
    <div
      style={{
        display: "flex",
        // Single-line tiles stay centred (unchanged); a tile carrying a breakdown aligns to the top.
        alignItems: children ? "flex-start" : "center",
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
        {children}
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
const edgeName = (e: { from: string; to: string }): string =>
  `${e.from} → ${e.to}`;
/**
 * `when <path> <op> <value>`. The VALUE is included — an edited threshold is the commonest
 * condition edit there is, and `when count gt → when count gt` describes it as no change at all.
 * `exists`/`isEmpty`/`notEmpty` ignore their value, so it is left off for those.
 */
const conditionText = (c?: DiffEdge["condition"]): string => {
  if (!c) return "always";
  const valueless =
    c.op === "exists" || c.op === "isEmpty" || c.op === "notEmpty";
  if (valueless || c.value === undefined) return `when ${c.path} ${c.op}`;
  const v = JSON.stringify(c.value) ?? String(c.value);
  return `when ${c.path} ${c.op} ${v.length > 60 ? `${v.slice(0, 60)}…` : v}`;
};
const edgeDetail = (e: DiffEdge): string | undefined =>
  e.condition ? conditionText(e.condition) : undefined;

/**
 * The per-field breakdown that lives INSIDE a changed node's tile — the answer to "which input
 * changed", which used to read as the single word `config`.
 *
 * Values wrap rather than ellipsing: the diff already clipped them at the source and said so in
 * the text (`… [truncated, N chars total]`), so a CSS ellipsis on top would hide a truncation the
 * data went out of its way to announce.
 */
function FieldChanges({
  details,
  omitted,
}: {
  details: FieldChange[];
  omitted: number;
}) {
  // `?? []` guards the WIRE, not the type: DiffModal's diff arrives as JSON from `/diff` and is
  // cast, so an API mid-rolling-deploy can hand back a payload without `details`. A missing
  // breakdown should render the tile it belongs to, not throw the whole panel away.
  const list = details ?? [];
  if (list.length === 0 && !omitted) return null;
  const side = (text: string, dim: boolean) => (
    <span
      className="mono"
      style={{
        color: dim ? "var(--ink-faint)" : "var(--ink-2)",
        wordBreak: "break-word",
      }}
    >
      {text}
    </span>
  );
  return (
    <div
      style={{
        marginTop: 7,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: "var(--text-2xs)",
      }}
    >
      {list.map((d) => (
        <div key={`${d.kind}-${d.path}`} style={{ lineHeight: 1.45 }}>
          <span
            className="mono"
            style={{
              color: "var(--ink)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {d.path}
          </span>{" "}
          {d.before !== undefined && side(d.before, true)}
          {d.before !== undefined && d.after !== undefined && (
            <span style={{ color: "var(--ink-faint)" }}> → </span>
          )}
          {d.after !== undefined && side(d.after, false)}
          {d.before === undefined && (
            <span style={{ color: "var(--state-done)" }}> (added)</span>
          )}
          {d.after === undefined && (
            <span style={{ color: "var(--state-error)" }}> (removed)</span>
          )}
          {d.note && (
            <span style={{ color: "var(--ink-faint)" }}> · {d.note}</span>
          )}
        </div>
      ))}
      {omitted > 0 && (
        // Never let a cap be silent — an unshown change is still a change being promoted.
        <div style={{ color: "var(--ink-faint)" }}>
          + {omitted} more field{omitted === 1 ? "" : "s"} changed (not shown)
        </div>
      )}
    </div>
  );
}

/** Nothing structural changed. Exported so callers can offer their own wording for it. */
export function isEmptyDiff(d: GraphDiff): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    // `?? []`/`?.` here and below guard the WIRE, not the type — see FieldChanges: the `/diff`
    // payload is cast, not validated, so an API mid-rolling-deploy can omit `edgesChanged`.
    (d.edgesChanged?.length ?? 0) === 0 &&
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
    (d.edgesChanged?.length ?? 0) +
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
      {/* ONE tile per node, however many of its fields moved — the breakdown goes inside it. */}
      {diff.nodesChanged.map((c) => (
        <DiffRow
          key={`nc-${c.id}`}
          kind="chg"
          icon={nodeIcon(c.after.type as NodeType)}
          accent={ACCENT[c.after.type as NodeType] ?? "var(--ink-2)"}
          name={nodeName(c.after)}
          detail={`${c.id} · ${c.fields.join(", ")}`}
        >
          <FieldChanges details={c.details} omitted={c.detailsOmitted} />
        </DiffRow>
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
      {/* The route is unchanged; only its predicate moved. Before #1020 this rendered as an
          "edge removed" tile beside an "edge added" one — the same edit, shown twice, reading as
          routing torn out and rebuilt. One tile, both sides of the condition. */}
      {/* `?? []` guards the wire, not the type — see isEmptyDiff. */}
      {(diff.edgesChanged ?? []).map((e, i) => (
        <DiffRow
          key={`ec-${i}-${e.from}-${e.to}`}
          kind="chg"
          icon="arrow-right"
          accent="var(--ink-2)"
          name={edgeName(e)}
          detail={`${conditionText(e.before)} → ${conditionText(e.after)}`}
          tag="edge changed"
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
      {/* Edge ORDER is semantically significant, so a pure reorder is a real behaviour change,
          not cosmetic. NOT because the interpreter takes the first matching outgoing edge — it
          takes EVERY passing one (nextNodes) — but because edge order sets fan-out start order
          and decides which branch's terminal wins. See GraphDiff.edgesReordered. */}
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
