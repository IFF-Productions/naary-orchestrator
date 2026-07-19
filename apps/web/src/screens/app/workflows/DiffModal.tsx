/**
 * Version-diff MODAL (redesign "Naary Workflows.dc.html") — the restyled
 * successor of the old inline WorkflowDiffPanel. Renders the server-computed
 * structural diff (GET /graphs/:key/diff → diffGraphs in @naary/dsl) as
 * +/~/− rows with node icon tiles, per-row tinted borders, a summary-count
 * footer, and an optional "Promote" CTA.
 *
 * Two entry modes:
 * - cross-env ("View diff: sandbox → prod"): the parent resolves the target
 *   env's latest contentHash to a version in the ACTIVE env's history and
 *   passes it as `preset` — the modal auto-compares. When the target's content
 *   isn't in the active history, the parent passes a `note` and the pickers
 *   fall back to in-env comparison (the old panel's capability, kept).
 * - manual ("Compare…" from Version history): pickers only, user-driven.
 */
import { useEffect, useState } from "react";
import type { GraphDiff, NodeType } from "@naary/dsl";
import { Icon, type IconName, Spinner } from "../../../components";
import { api, type GraphVersion } from "../../../lib/api";
import { nodeDisplayLabel } from "../../../lib/graph-model";
import { ACCENT } from "../../../lib/graph-model";
import { nodeIcon } from "./model";

type Diff = GraphDiff & { fromVersion: number; toVersion: number };
type DiffNode = GraphDiff["nodesAdded"][number];
type DiffEdge = GraphDiff["edgesAdded"][number];

export interface DiffPreset {
  from: number;
  to: number;
  /** Mono subtitle, e.g. "prod v6 → sandbox v9". */
  title: string;
}

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

function DiffRow({
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

function isEmpty(d: GraphDiff): boolean {
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

export function DiffModal({
  workflowKey,
  open,
  onClose,
  versions,
  preset,
  note,
  promoteCta,
}: {
  workflowKey: string;
  open: boolean;
  onClose: () => void;
  /** ACTIVE-env version history (newest first) — feeds the pickers. */
  versions: GraphVersion[];
  /** Auto-compare on open (cross-env entry). Null = manual pickers. */
  preset: DiffPreset | null;
  /** Honest caveat shown when a cross-env diff had to fall back to in-env. */
  note?: string;
  /** "Promote to prod" footer CTA (only for the cross-env entry + share perm). */
  promoteCta?: { label: string; onClick: () => void } | null;
}) {
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function compare(f: number, t: number): Promise<void> {
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      setDiff(await api.diffGraphVersions(workflowKey, f, t));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not compute the diff.");
    } finally {
      setLoading(false);
    }
  }

  // Seed pickers (and auto-compare for a preset) each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setDiff(null);
    setError(null);
    if (preset) {
      setFrom(preset.from);
      setTo(preset.to);
      void compare(preset.from, preset.to);
    } else if (versions.length >= 2) {
      setTo(versions[0].version);
      setFrom(versions[1].version);
    } else if (versions.length === 1) {
      setTo(versions[0].version);
      setFrom(versions[0].version);
    }
    // compare is stable per render; re-seeding is keyed on open/preset only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset, workflowKey]);

  if (!open) return null;

  const pick = (
    value: number | "",
    onChange: (v: number) => void,
    label: string,
  ) => (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--text-xs)",
        color: "var(--ink-3)",
      }}
    >
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          fontSize: "var(--text-sm)",
          padding: "4px 8px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
        }}
      >
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version}
          </option>
        ))}
      </select>
    </label>
  );

  const counts = diff
    ? {
        add: diff.nodesAdded.length + diff.edgesAdded.length,
        chg:
          diff.nodesChanged.length +
          (diff.startNodeChanged ? 1 : 0) +
          (diff.edgesReordered ? 1 : 0),
        del: diff.nodesRemoved.length + diff.edgesRemoved.length,
      }
    : null;

  return (
    <div className="overlay" onClick={onClose} style={{ padding: 36 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 900,
          maxWidth: "100%",
          maxHeight: "100%",
          margin: "auto",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--line-mid)",
          borderRadius: 18,
          boxShadow: "0 40px 100px -40px rgba(0,0,0,.8)",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
              }}
            >
              Version diff
            </div>
            <div
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                marginTop: 2,
              }}
            >
              {preset
                ? preset.title
                : diff
                  ? `v${diff.fromVersion} → v${diff.toVersion}`
                  : "pick two versions to compare"}
            </div>
          </div>
          {/* Manual pickers — the old panel's in-env compare, kept. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {pick(from, setFrom, "from")}
            <span style={{ color: "var(--ink-3)" }}>→</span>
            {pick(to, setTo, "to")}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={loading || from === "" || to === ""}
              onClick={() => from !== "" && to !== "" && void compare(from, to)}
            >
              Compare
            </button>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
          {note && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--state-paused)",
                marginBottom: 12,
              }}
            >
              {note}
            </div>
          )}
          {error && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--state-error)",
              }}
            >
              {error}
            </div>
          )}
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--ink-3)",
                fontSize: "var(--text-sm)",
              }}
            >
              <Spinner size={14} /> Computing diff…
            </div>
          )}
          {!loading && !error && !diff && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              {versions.length < 2
                ? "Only one saved version — nothing to compare yet."
                : "Pick two versions and hit Compare."}
            </div>
          )}
          {diff && isEmpty(diff) && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              No structural changes between these versions.
            </div>
          )}
          {diff && !isEmpty(diff) && (
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
          )}
        </div>

        {/* footer */}
        <div
          style={{
            padding: "15px 22px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {counts && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                display: "flex",
                gap: 14,
              }}
            >
              <span>
                <span
                  style={{
                    color: "var(--state-done)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  +{counts.add}
                </span>{" "}
                added
              </span>
              <span>
                <span
                  style={{
                    color: "var(--state-paused)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  ~{counts.chg}
                </span>{" "}
                changed
              </span>
              <span>
                <span
                  style={{
                    color: "var(--state-error)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  −{counts.del}
                </span>{" "}
                removed
              </span>
            </div>
          )}
          {promoteCta && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginLeft: "auto" }}
              onClick={promoteCta.onClick}
            >
              {promoteCta.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
