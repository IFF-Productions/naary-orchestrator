/**
 * The grant MATRIX table (RBAC-GROUPS.md §4/§8, redesign "1a — two-pane matrix table"):
 * one row per grant, six verb cells toggled inline. Pure/presentational — persistence and
 * the first-grant cliff live in the parent; this renders rows and reports intents (toggle,
 * edit, delete) via callbacks.
 */
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
  return (
    <div style={{ overflowX: "auto", marginBottom: 10 }}>
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
