/**
 * Version-diff MODAL (redesign "Naary Workflows.dc.html") — the restyled
 * successor of the old inline WorkflowDiffPanel. Owns the VERSION-COMPARISON
 * part: the pickers, the fetch (GET /graphs/:key/diff), and an optional
 * "Promote" CTA.
 *
 * The rendering — +/~/− rows and the summary counts — moved to `GraphDiffBody`,
 * so a diff computed some other way can be shown the same way. The canvas
 * reviews an UNSAVED AI edit against the graph it started from, which is a
 * `diffGraphs` call in the browser with no versions and no fetch involved; that
 * has no business reaching for a modal that owns pickers and a version history.
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
import type { GraphDiff } from "@naary/dsl";
import { Icon, Spinner } from "../../../components";
import { api, type GraphVersion } from "../../../lib/api";
import { GraphDiffBody, GraphDiffCounts, isEmptyDiff } from "./GraphDiffBody";

type Diff = GraphDiff & { fromVersion: number; toVersion: number };

export interface DiffPreset {
  from: number;
  to: number;
  /** Mono subtitle, e.g. "prod v6 → sandbox v9". */
  title: string;
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
          animation: "naaryPopIn .22s ease",
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
          {diff && isEmptyDiff(diff) && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              No structural changes between these versions.
            </div>
          )}
          {diff && <GraphDiffBody diff={diff} />}
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
          {diff && <GraphDiffCounts diff={diff} />}
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
