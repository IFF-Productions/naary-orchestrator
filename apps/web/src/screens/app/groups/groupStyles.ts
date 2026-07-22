/**
 * Shared constants + styles for the Groups screen (RBAC-GROUPS.md §4/§4a/§8, slice G2)
 * and its extracted panels. Only holds what MORE THAN ONE groups/* file needs — each
 * panel keeps its single-consumer styles local, mirroring GrantEditor.tsx's house style.
 */
import type { GrantDraft } from "../../../lib/permissions-logic";

/** Scope/role tints with no design token yet (decorative): brand ember + purple + blue. */
export const SCOPE_ALL = "var(--brand)";
export const SCOPE_SELECTED = "#4a9dff";
export const SCOPE_TAG = "#c07bff";

/** Stable per-group dot color (decorative — no server field). */
const DOT_PALETTE = [
  "var(--brand)",
  "#c07bff",
  "#4a9dff",
  "#3fb27f",
  "#f5b544",
  "#e0607e",
];
export function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length];
}

/** The verb fields the matrix toggles (order + copy per the redesign header). */
export type MatrixVerbField = keyof Pick<
  GrantDraft,
  "canView" | "canRun" | "canEdit" | "canDelete" | "canShare" | "canCreate"
>;

/** The six matrix columns (order + copy per the redesign header). */
export const MATRIX_VERBS: { field: MatrixVerbField; label: string }[] = [
  { field: "canView", label: "view" },
  { field: "canRun", label: "run" },
  { field: "canEdit", label: "edit" },
  { field: "canDelete", label: "delete" },
  { field: "canShare", label: "Promote" },
  { field: "canCreate", label: "create" },
];

export const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};

export const sectionLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginBottom: 6,
};

export const mutedStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
};
