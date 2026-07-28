/**
 * Workflow picker for the `workflowKey` of the sub-workflow nodes — `executeSubWorkflow` and
 * `forEach` (which runs a child workflow per item).
 *
 * Both fields used to be free text with a placeholder like "my-saved-workflow". A workflow KEY is a
 * slug the author never chose and rarely sees — it's derived from the name at first save — so the
 * field asked people to recall a string the product had never shown them, and a typo produced a
 * graph that saved cleanly and failed at run time when the child couldn't be resolved.
 *
 * Self-fetching (like ./TemplateSelect) rather than fed by props: the config panels take a single
 * shared props object threaded from CanvasPage, and a picker that needs one list shouldn't widen
 * that contract for every node type.
 *
 * NO entry-type filter, deliberately. A child is launched by handing its graph to `runGraph` with
 * an input — the entry node's type never enters into it (engine/node-exec.ts) — so every saved
 * workflow is a legitimate target. Filtering to "callable-looking" entries would hide working
 * choices on a guess about intent.
 *
 * Self-reference is likewise offered, not blocked: a graph that calls itself is bounded by
 * MAX_SUBWORKFLOW_DEPTH server-side (which returns `circuit_open`, not a hang), and recursion with
 * a depth cap is a real pattern.
 */
import { useEffect, useState } from "react";
import { api, type GraphSummary } from "../../lib/api";
import { inputStyle } from "./fields";
import {
  MANUAL_OPTION,
  workflowSelectChoice,
  workflowSelectView,
} from "./workflow-select-model";

const hint: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
  marginTop: 4,
};

export function WorkflowSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (workflowKey: string) => void;
}) {
  const [workflows, setWorkflows] = useState<GraphSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The escape hatch: authors legitimately reference a child they haven't saved yet (building
  // parent and child together). A plain <select> would make that unexpressible — the one real
  // regression in trading a text input for a list — so typing a key stays reachable.
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .listGraphs()
      .then((list) => live && setWorkflows(list))
      .catch(() => {
        if (!live) return;
        // Say so AND fall back to typing: a failed list must not strand the author with a
        // dropdown that can only offer what they already had.
        setWorkflows([]);
        setFailed(true);
        setManual(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (workflows === null)
    return (
      <select disabled style={inputStyle}>
        <option>Loading workflows…</option>
      </select>
    );

  const view = workflowSelectView(value, workflows);

  if (manual)
    return (
      <>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
          placeholder="workflow-key"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the author chose this input
          autoFocus
        />
        <div style={hint}>
          {failed ? (
            <>Couldn’t load the workflow list — enter the key by hand.</>
          ) : (
            <>
              The key is the workflow’s slug, from its URL.{" "}
              <button
                type="button"
                onClick={() => setManual(false)}
                style={linkStyle}
              >
                Pick from the list instead
              </button>
            </>
          )}
        </div>
      </>
    );

  return (
    <>
      <select
        value={value}
        onChange={(e) => {
          const choice = workflowSelectChoice(e.target.value);
          if ("manual" in choice) return setManual(true);
          onChange(choice.key);
        }}
        style={inputStyle}
      >
        <option value="">{view.placeholder}</option>
        {workflows.map((w) => (
          <option key={w.workflowKey} value={w.workflowKey}>
            {w.name} ({w.workflowKey})
          </option>
        ))}
        {/* Carries the real key so the <select> has an option matching its own value — without
            it the browser falls back to the first option and the node looks untargeted. */}
        {view.unknownValue && (
          <option value={value}>{value} (not in this list)</option>
        )}
        <option value={MANUAL_OPTION}>Enter a key manually…</option>
      </select>
      {view.unknownValue && (
        <div style={hint}>
          No saved workflow has this key here — it may live in another
          environment, or not be saved yet. It will fail at run time if the
          child can’t be resolved.
        </div>
      )}
    </>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--brand)",
  cursor: "pointer",
  font: "inherit",
};
