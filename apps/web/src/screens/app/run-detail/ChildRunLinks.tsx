/**
 * Parent → child run links for the two nodes that spawn child runs (#960).
 *
 * A sub-workflow child records its own Execution row and shows up in the Runs list, but the
 * parent's step only ever showed a `{status, output}` projection — so tracing a parent→child
 * failure meant hunting the child by timestamp. The worker now returns the child's Temporal
 * workflowId ON the node output (`childRunId`), and this renders it as a link.
 *
 * It reads that field rather than rebuilding the id from its format
 * (`<parentId>-sub-<nodeId>-<stepCount>`, which lives in the interpreter): a format change would
 * then produce DEAD LINKS here — a failure with no error, which is the worst kind.
 *
 * Everything degrades on absence, because it genuinely is absent: a run recorded before #960 has
 * no `childRunId`, so `childRunLinks` returns [] and the section renders NOTHING at all — no
 * empty header, no link to a run id we don't have.
 */
import { Link } from "react-router-dom";
import { StatusPill } from "../../../components";
import { runStatusUi } from "../../../lib/run-status";

/** One spawned child run: the run to open, its terminal status, and how to name it. */
export interface ChildRunLink {
  /** The child's Temporal workflowId = its key in the Runs list / `/app/runs/:id`. */
  childRunId: string;
  /** The child's terminal status as the parent recorded it (`completed`, `failed`, …). */
  status?: string;
  /** Row label: "Child run" for a sub-workflow, "Item N" for a forEach item. */
  label: string;
}

/**
 * How many links we render before collapsing the rest into a count. forEach fans out to
 * MAX_FOREACH_ITEMS children (hundreds), and a list that long buries the step's own output;
 * the Runs list is the right surface for the full set.
 */
export const MAX_CHILD_RUN_LINKS = 20;

function entry(raw: unknown, label: string): ChildRunLink | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { childRunId?: unknown; status?: unknown };
  // A non-empty string is the whole contract: anything else (missing on a pre-#960 run, or a
  // shape we don't recognise) means we have no run to open, so we offer no link.
  if (typeof o.childRunId !== "string" || !o.childRunId) return null;
  return {
    childRunId: o.childRunId,
    status: typeof o.status === "string" ? o.status : undefined,
    label,
  };
}

/**
 * The child runs a step spawned, in the order the interpreter collected them.
 *
 * Gated on `nodeType`: only executeSubWorkflow and forEach spawn children, so a `childRunId`
 * appearing in some OTHER node's output (an HTTP body echoing that field, say) is data, not a
 * run we own — linking it would send the user to a 404.
 */
export function childRunLinks(
  output: unknown,
  nodeType?: string,
): ChildRunLink[] {
  if (nodeType === "executeSubWorkflow") {
    const one = entry(output, "Child run");
    return one ? [one] : [];
  }
  if (nodeType === "forEach") {
    if (!Array.isArray(output)) return [];
    // Per item, so a partially-old array (or an entry we can't read) drops only that row —
    // the items that DO carry an id still link.
    return output
      .map((item, i) => entry(item, `Item ${i + 1}`))
      .filter((e): e is ChildRunLink => e !== null);
  }
  return [];
}

/** The step's child runs as links, or nothing at all when there are none to offer. */
export function ChildRunLinks({
  output,
  nodeType,
}: {
  output: unknown;
  nodeType?: string;
}) {
  const links = childRunLinks(output, nodeType);
  if (links.length === 0) return null;
  const shown = links.slice(0, MAX_CHILD_RUN_LINKS);

  return (
    <div
      style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}
    >
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "var(--ink-faint)",
          marginBottom: 9,
        }}
      >
        {links.length === 1 ? "Child run" : `Child runs (${links.length})`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((c) => (
          <Link
            key={c.childRunId}
            to={`/app/runs/${encodeURIComponent(c.childRunId)}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              textDecoration: "none",
              color: "var(--ink-soft)",
              fontSize: "var(--text-sm)",
            }}
          >
            <span style={{ flex: "none" }}>{c.label}</span>
            {c.status && (
              <StatusPill
                state={runStatusUi(c.status).state}
                label={runStatusUi(c.status).label}
              />
            )}
            <span
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textAlign: "right",
              }}
            >
              {c.childRunId}
            </span>
          </Link>
        ))}
      </div>
      {links.length > shown.length && (
        <div
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            marginTop: 6,
          }}
        >
          +{links.length - shown.length} more child runs — find them in the Runs
          list.
        </div>
      )}
    </div>
  );
}
