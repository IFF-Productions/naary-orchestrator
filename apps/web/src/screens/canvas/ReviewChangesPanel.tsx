/**
 * "Review changes" — what the canvas holds that a save would persist, as a diff against the
 * graph it started from.
 *
 * WHY THIS EXISTS. An AI edit rewrites the whole graph and hands it back; until now the only
 * report of what it did was the canvas itself, which the user must re-read node by node to spot
 * anything unintended. That is not a theoretical gap: "I ran <a change request> on the Canvas
 * build with Agent, and it rewrote the whole workflow without updating it" is what prompted the
 * edit prompt's preservation rules ("keep every existing node's id, type and config
 * BYTE-FOR-BYTE unless that node is what the change is about"). Those rules are asserted
 * NOWHERE. This panel is what makes them observable: a faithful edit shows the nodes it meant to
 * touch, and an edit that quietly rewrote four others shows four extra changed rows.
 *
 * It is deliberately not AI-specific. Any unsaved work — hand edits included — is worth being
 * able to see before saving, and a review surface that only appears after a generation would be
 * one more thing to remember rather than a habit.
 *
 * NOTHING HERE SAVES. The panel reports; `Save` in the top bar remains the only thing that
 * persists, so this cannot become a second write path that drifts from the first.
 */
import { diffGraphs, type GraphDef } from "@naary/dsl";
import { Icon } from "../../components";
import {
  diffCounts,
  GraphDiffBody,
  isEmptyDiff,
} from "../app/workflows/GraphDiffBody";

export function ReviewChangesPanel({
  baseline,
  graph,
  baselineName,
  name,
  onClose,
}: {
  /** The graph as last saved or presented — see useUnsavedChanges for why this is the right base. */
  baseline: GraphDef;
  /** The live-compiled canvas; undefined while it doesn't compile. */
  graph: GraphDef | undefined;
  baselineName: string;
  name: string;
  onClose: () => void;
}) {
  const renamed = baselineName.trim() !== name.trim();
  // An uncompilable canvas has no diff to show, and saying "no changes" there would be the exact
  // opposite of the truth — it got that way by being edited.
  const diff = graph ? diffGraphs(baseline, graph) : null;
  const counts = diff ? diffCounts(diff) : null;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--line)",
        background: "var(--panel)",
        padding: "14px 18px",
        maxHeight: "38vh",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          Review changes
        </div>
        {counts && counts.total > 0 && (
          <span
            className="mono"
            style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}
          >
            {counts.total} change{counts.total > 1 ? "s" : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Close review"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        Compared with the last saved version. Nothing is saved until you press
        Save.
      </div>

      {/* A rename is a real unsaved change and is invisible in a structural diff — the graph can
          be byte-identical while the workflow is called something else. */}
      {renamed && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-paused)",
            marginBottom: 10,
          }}
        >
          Renamed: “{baselineName}” → “{name}”
        </div>
      )}

      {!graph && (
        <div
          style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
        >
          The canvas doesn’t compile right now, so its changes can’t be compared
          — fix the errors above and this will fill in.
        </div>
      )}

      {diff && isEmptyDiff(diff) && !renamed && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No changes to save — this canvas matches the last saved version.
        </div>
      )}

      {diff && <GraphDiffBody diff={diff} />}
    </div>
  );
}
