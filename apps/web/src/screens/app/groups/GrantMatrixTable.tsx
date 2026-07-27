/**
 * The grant MATRIX table (RBAC-GROUPS.md §4/§8, redesign "1a — two-pane matrix table"):
 * one row per grant, six verb cells toggled inline. Pure/presentational — persistence and
 * the first-grant cliff live in the parent; this renders rows and reports intents (toggle,
 * edit, delete) via callbacks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, Spinner } from "../../../components";
import type { GroupGrant } from "../../../lib/api";
import {
  MATRIX_VERBS,
  type MatrixVerbField,
  SCOPE_ALL,
  SCOPE_SELECTED,
  SCOPE_TAG,
} from "./groupStyles";

export function GrantMatrixTable({
  grants,
  canManage,
  belowDrawer,
  togglingCell,
  envName,
  wfName,
  tagName,
  onToggleVerb,
  onEditGrant,
  onDeleteGrant,
  iconBtn,
}: {
  grants: GroupGrant[];
  canManage: boolean;
  belowDrawer: boolean;
  togglingCell: string | null;
  envName: (id: string | null) => string;
  wfName: (key: string) => string;
  tagName: (id: string) => string;
  onToggleVerb: (grant: GroupGrant, field: MatrixVerbField) => void;
  onEditGrant: (grant: GroupGrant) => void;
  onDeleteGrant: (grant: GroupGrant) => void;
  iconBtn: React.CSSProperties;
}) {
  /**
   * SCROLL AFFORDANCE (#708). At 390px this table hides 296px — 47% of every row — behind a
   * scroller with nothing to say so. Unlike the other tables in that issue it must NOT become
   * cards: a permission matrix is a grid by nature, and its checkboxes sit ~37px apart
   * centre-to-centre, so it also must not get a blanket touch-target bump (the expanded areas
   * would overlap into mis-taps). Horizontal scroll is the right answer here — it just has to be
   * VISIBLE, which is what #708 asks for and what this adds.
   *
   * Edge fades, shown only on the side that actually has more content, so they never imply
   * hidden columns that aren't there.
   */
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({
      left: el.scrollLeft > 1,
      // 1px slack: sub-pixel layout can leave scrollLeft a hair short of max at the end.
      right: max > 1 && el.scrollLeft < max - 1,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    // ResizeObserver too: a viewport change alters what fits without any scroll event firing.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The TABLE too, not just the viewport: adding a grant can widen the content without the
    // scroller's own box changing size, and a ResizeObserver on the scroller alone would miss it.
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
    // `grants` in the deps as well — a re-render with different rows must re-measure even if
    // neither box resized (e.g. a longer target chip in the same-width column).
  }, [measure, grants]);

  return (
    <div style={{ position: "relative", marginBottom: 10 }}>
      {(["left", "right"] as const).map((side) =>
        edges[side] ? (
          <div
            key={side}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              [side]: 0,
              width: 26,
              pointerEvents: "none",
              zIndex: 1,
              background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--panel), transparent)`,
            }}
          />
        ) : null,
      )}
      <div ref={scroller} onScroll={measure} style={{ overflowX: "auto" }}>
      <table
        style={{
          minWidth: 560,
          width: "100%",
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: "left" }}>Scope target</th>
            {MATRIX_VERBS.map((v) => (
              <th key={v.field} style={thStyle}>
                {v.label}
              </th>
            ))}
            {canManage && <th style={thStyle} />}
          </tr>
        </thead>
        <tbody>
          {grants.map((grant) => (
            <tr key={grant.id} style={{ borderTop: "1px solid var(--line)" }}>
              <td style={{ ...tdStyle, textAlign: "left" }}>
                <ScopeTarget
                  grant={grant}
                  envName={envName}
                  wfName={wfName}
                  tagName={tagName}
                />
              </td>
              {MATRIX_VERBS.map((v) => {
                const locked =
                  v.field === "canCreate" && grant.scope === "selected";
                return (
                  <td key={v.field} style={tdStyle}>
                    <VerbCell
                      on={grant[v.field]}
                      locked={locked}
                      touch={belowDrawer}
                      busy={togglingCell === `${grant.id}:${v.field}`}
                      // Disable EVERY verb cell while any save is in flight —
                      // togglingCell tracks a single cell, so a concurrent click
                      // elsewhere would race and the first finally() clears busy.
                      disabled={!canManage || togglingCell !== null}
                      label={v.label}
                      onToggle={() => onToggleVerb(grant, v.field)}
                    />
                  </td>
                );
              })}
              {canManage && (
                <td style={tdStyle}>
                  <span
                    style={{
                      display: "flex",
                      gap: 2,
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      aria-label="Edit grant scope"
                      title="Edit scope, targets and environment"
                      onClick={() => onEditGrant(grant)}
                      style={iconBtn}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete grant"
                      title="Delete grant"
                      onClick={() => onDeleteGrant(grant)}
                      style={iconBtn}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** The scope + target cell: role-tinted scope icon then mono target chips. A single
 *  'selected' grant can carry several workflow keys AND tags (all shown); a non-null
 *  environmentId is load-bearing (grants are per-env) so it rides along as a chip. */
function ScopeTarget({
  grant,
  envName,
  wfName,
  tagName,
}: {
  grant: GroupGrant;
  envName: (id: string | null) => string;
  wfName: (key: string) => string;
  tagName: (id: string) => string;
}) {
  const isAll = grant.scope === "all";
  const tint = isAll ? SCOPE_ALL : SCOPE_SELECTED;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
      <span
        style={{
          width: 22,
          height: 22,
          flex: "none",
          marginTop: 1,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          color: tint,
          background: `color-mix(in srgb, ${tint} 16%, transparent)`,
        }}
      >
        <Icon name={isAll ? "grid" : "workflow"} size={13} />
      </span>
      <span style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
        {isAll ? (
          <span style={targetChip("var(--brand)")}>All workflows</span>
        ) : (
          <>
            {grant.workflowKeys.map((k) => (
              <span
                key={`wf:${k}`}
                title={wfName(k)}
                style={targetChip(SCOPE_SELECTED)}
              >
                wf: {k}
              </span>
            ))}
            {(grant.tagIds ?? []).map((id) => (
              <span
                key={`tag:${id}`}
                title={tagName(id)}
                style={targetChip(SCOPE_TAG)}
              >
                tag: {id}
              </span>
            ))}
            {grant.workflowKeys.length === 0 &&
              (grant.tagIds ?? []).length === 0 && (
                <span style={targetChip("var(--ink-3)")}>no targets</span>
              )}
          </>
        )}
        {grant.environmentId !== null && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              alignSelf: "center",
            }}
          >
            @ {envName(grant.environmentId)}
          </span>
        )}
      </span>
    </div>
  );
}

/** One verb toggle cell: a green tap-target when on; a LOCK + disabled when `locked`
 *  (create off a selected scope). Persist happens in the parent — this is presentational
 *  plus a busy spinner. */
function VerbCell({
  on,
  locked,
  touch,
  busy,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  locked: boolean;
  touch: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  const size = touch ? 44 : 30;
  if (locked) {
    return (
      <span
        title="Create requires the All-workflows scope"
        aria-label={`${label} locked (requires All workflows)`}
        style={{
          display: "inline-grid",
          placeItems: "center",
          width: size,
          height: size,
          color: "var(--ink-3)",
          opacity: 0.5,
        }}
      >
        <LockGlyph />
      </span>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onToggle}
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        margin: "0 auto",
        padding: 0,
        borderRadius: 7,
        cursor: disabled ? "default" : "pointer",
        border: `1px solid ${on ? "var(--state-done)" : "var(--line-2)"}`,
        background: on ? "var(--state-done)" : "transparent",
        color: on ? "#fff" : "var(--ink-3)",
        opacity: busy ? 0.7 : 1,
        transition: "background .12s ease, border-color .12s ease",
      }}
    >
      {busy ? (
        <Spinner
          size={14}
          color={on ? "#fff" : "var(--ink-3)"}
          track={
            on ? "color-mix(in srgb, #fff 35%, transparent)" : "var(--line-2)"
          }
        />
      ) : (
        on && <Icon name="check" size={15} />
      )}
    </button>
  );
}

/** Small inline lock (no `lock` in the icon set). */
function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="5"
        y="11"
        width="14"
        height="9"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

const thStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  textAlign: "center",
  padding: "0 6px 8px",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 6px",
  textAlign: "center",
  verticalAlign: "middle",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
};

function targetChip(tint: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-xs)",
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    color: tint,
    background: `color-mix(in srgb, ${tint} 12%, transparent)`,
    whiteSpace: "nowrap",
  };
}
