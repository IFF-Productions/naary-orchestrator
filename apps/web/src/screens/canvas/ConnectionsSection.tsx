/**
 * "Connects to" — connect nodes from the CONFIG PANEL instead of dragging on the canvas (#1026).
 *
 * Dragging between two handles stays the fast path on a desktop; this is the one that also works
 * with a keyboard, on a phone, and when the target node is off-screen. Everything here is a native
 * `<select>` / `<button>`, so it is tab-reachable and operable with Enter/Space with no key
 * handling of our own — that accessibility is half the reason the section exists.
 *
 * ORDER: the rows are the node's outgoing edges in their REAL array order (see connect-model), and
 * the ↑/↓ controls edit that order. Nothing here sorts. The interpreter takes every outgoing edge
 * whose condition passes, in this order, so the sequence decides which branch starts first and —
 * when two branches both end the run — whose outcome the run reports.
 */
import type { NodeType } from "@naary/dsl";
import { Icon } from "../../components";
import {
  canHaveIncoming,
  canHaveOutgoing,
  conditionSummary,
  type ConnectEdge,
  type ConnectNode,
  connectableTargets,
  incomingConnections,
  outgoingConnections,
} from "./connect-model";
import { inputStyle } from "./fields";

/** Everything the canvas hands the section: the graph as it really is, plus the four edits. */
export interface ConnectEditing {
  /** ALL canvas edges, in their true array order — never pre-filtered or sorted. */
  edges: readonly ConnectEdge[];
  /** Every node on the canvas (id + kind + display label). */
  nodes: readonly ConnectNode[];
  /** Append an edge from this node to `targetId` (a duplicate is refused). */
  onAdd: (targetId: string) => void;
  /** Move an outgoing edge one place earlier (-1) / later (+1) among its siblings. */
  onMove: (edgeId: string, dir: -1 | 1) => void;
  onRemove: (edgeId: string) => void;
  /** Open the existing Connection inspector on this edge (where conditions are edited). */
  onEditCondition: (edgeId: string) => void;
  /** Live run-watch: the canvas disables node drag/connect, so editing is read-only here too. */
  readOnly?: boolean;
}

const SECTION_HEAD: React.CSSProperties = {
  fontSize: "var(--text-2xs)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-faint)",
  fontWeight: "var(--weight-semibold)",
};

const ICON_BUTTON: React.CSSProperties = {
  width: 26,
  height: 26,
  flex: "none",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink-2)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/**
 * Keep the keyboard somewhere useful after a reorder.
 *
 * The ↑/↓ pair is disabled at the ends of the list, and a browser DROPS focus off a control that
 * becomes disabled — so moving a connection to the top would land a keyboard user back on `<body>`
 * with nothing to press. After the re-render, hand focus to the row's other move button (always
 * enabled once this one isn't, since the pair is only rendered for a list of two or more). The row
 * is keyed by edge id, so React moves this exact element rather than reusing it for another
 * connection — which is what makes `button` still the right thing to look at here.
 */
function keepFocusAfterMove(
  button: HTMLButtonElement,
  sibling: "next" | "previous",
): void {
  requestAnimationFrame(() => {
    if (!button.disabled) return;
    const other =
      sibling === "next"
        ? button.nextElementSibling
        : button.previousElementSibling;
    if (other instanceof HTMLButtonElement && !other.disabled) other.focus();
  });
}

function iconButtonStyle(disabled: boolean): React.CSSProperties {
  return disabled
    ? { ...ICON_BUTTON, cursor: "not-allowed", opacity: 0.4 }
    : ICON_BUTTON;
}

export function ConnectionsSection({
  nodeId,
  kind,
  connect,
}: {
  nodeId: string;
  kind: NodeType;
  connect: ConnectEditing;
}) {
  const { edges, nodes, readOnly } = connect;
  const outgoing = outgoingConnections(nodeId, edges);
  const incoming = incomingConnections(nodeId, edges);
  const labelOf = (id: string): string =>
    nodes.find((n) => n.id === id)?.label ?? id;
  const options = readOnly ? [] : connectableTargets(nodeId, nodes, edges);
  const terminal = !canHaveOutgoing(kind);
  // Said only when it is TRUE of this node: with two or more edges the order is doing real work.
  const orderMatters = outgoing.length > 1;

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={SECTION_HEAD}>Connects to</div>

      {terminal ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          The terminal node — the run stops here, so it has no outgoing
          connections.
        </div>
      ) : (
        <>
          {outgoing.length === 0 ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              Nothing yet — the run stops after this node. Pick a node below to
              connect it.
            </div>
          ) : (
            <>
              <ol
                aria-label={`Outgoing connections from ${labelOf(nodeId)}, in run order`}
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {outgoing.map(({ edge, position }, i) => {
                  const target = labelOf(edge.target);
                  const cond = conditionSummary(edge.data?.condition);
                  const unconditional = cond === "always";
                  // KEYED BY EDGE ID, never by index: on a reorder React must MOVE the row's
                  // DOM node rather than re-use it with new content, or keyboard focus would
                  // stay on the button that now belongs to a different connection and a second
                  // ↑ press would move the wrong edge.
                  return (
                    <li
                      key={edge.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        border: "1px solid var(--line-2)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--card)",
                        padding: "7px 9px",
                      }}
                    >
                      <span
                        className="mono"
                        aria-hidden
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-faint)",
                          width: 12,
                          flex: "none",
                        }}
                      >
                        {position}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: "var(--text-sm)",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {target}
                        </span>
                        <span
                          className="mono"
                          style={{
                            display: "block",
                            fontSize: "var(--text-2xs)",
                            color: unconditional
                              ? "var(--ink-faint)"
                              : "var(--ink-3)",
                            marginTop: 1,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {cond}
                        </span>
                      </span>
                      {!readOnly && (
                        <>
                          {/* Reorder controls only when there IS an order to edit — a lone
                              connection would otherwise show two permanently dead buttons. */}
                          {orderMatters && (
                            <>
                              <button
                                type="button"
                                aria-label={`Move the connection to ${target} earlier`}
                                disabled={i === 0}
                                onClick={(e) => {
                                  keepFocusAfterMove(e.currentTarget, "next");
                                  connect.onMove(edge.id, -1);
                                }}
                                style={iconButtonStyle(i === 0)}
                              >
                                <span aria-hidden>↑</span>
                              </button>
                              <button
                                type="button"
                                aria-label={`Move the connection to ${target} later`}
                                disabled={i === outgoing.length - 1}
                                onClick={(e) => {
                                  keepFocusAfterMove(
                                    e.currentTarget,
                                    "previous",
                                  );
                                  connect.onMove(edge.id, 1);
                                }}
                                style={iconButtonStyle(
                                  i === outgoing.length - 1,
                                )}
                              >
                                <span aria-hidden>↓</span>
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            aria-label={`Edit the condition on the connection to ${target}`}
                            onClick={() => connect.onEditCondition(edge.id)}
                            style={{
                              ...ICON_BUTTON,
                              width: "auto",
                              padding: "0 8px",
                              fontSize: "var(--text-xs)",
                            }}
                          >
                            Condition
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove the connection to ${target}`}
                            onClick={() => connect.onRemove(edge.id)}
                            style={{
                              ...ICON_BUTTON,
                              color: "var(--state-error)",
                            }}
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-faint)",
                  lineHeight: 1.5,
                }}
              >
                {orderMatters
                  ? // Deliberately NOT "first match wins": nextNodes() returns EVERY passing
                    // edge, so an unconditional connection does not capture the traffic of the
                    // conditional ones beside it. What the order really decides is said instead.
                    "Every connection whose condition passes is taken — an “always” row does not stop the ones below it. The order is still real: branches start in it, and if two of them end the run, the higher one's outcome is the run's. Reorder with ↑ ↓; saving keeps this order."
                  : "This connection is taken when its condition passes. “always” means every run."}
              </div>
            </>
          )}

          {!readOnly && (
            <AddConnection
              options={options}
              hasCandidates={nodes.length > 1}
              onAdd={connect.onAdd}
            />
          )}
        </>
      )}

      <div style={{ ...SECTION_HEAD, marginTop: 2 }}>Connected from</div>
      {incoming.length === 0 ? (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
          {canHaveIncoming(kind)
            ? "Nothing connects into this node — it only runs if something does."
            : "A trigger — it starts the run, so nothing connects into it."}
        </div>
      ) : (
        <ul
          aria-label={`Incoming connections into ${labelOf(nodeId)}`}
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {incoming.map((e) => (
            <li
              key={e.id}
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                overflowWrap: "anywhere",
              }}
            >
              {labelOf(e.source)}
              <span style={{ color: "var(--ink-faint)" }}> → this node</span>
              {conditionSummary(e.data?.condition) !== "always" && (
                <span className="mono" style={{ color: "var(--ink-faint)" }}>
                  {" "}
                  · {conditionSummary(e.data?.condition)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The picker itself: choose a target, press Add. A `<select>` + `<button>`, so the whole
 *  interaction is keyboard-only operable — which dragging between handles never is. */
function AddConnection({
  options,
  hasCandidates,
  onAdd,
}: {
  options: readonly ConnectNode[];
  /** Is there any other node at all? Distinguishes "nothing to connect to" from "all connected". */
  hasCandidates: boolean;
  onAdd: (targetId: string) => void;
}) {
  const id = "connect-to-target";
  if (options.length === 0) {
    return (
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
        {hasCandidates
          ? "Every node this one can reach is already connected."
          : "Add another node to the canvas to connect this one to it."}
      </div>
    );
  }
  return (
    <form
      // Submit (Enter from the select) adds it too — the keyboard path shouldn't need the mouse.
      onSubmit={(e) => {
        e.preventDefault();
        const value = new FormData(e.currentTarget).get(id);
        if (typeof value === "string" && value) onAdd(value);
      }}
      style={{ display: "flex", gap: 6, alignItems: "flex-end" }}
    >
      <label
        htmlFor={id}
        style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)" }}
      >
        <span style={{ color: "var(--ink-2)" }}>Connect to</span>
        <select
          id={id}
          name={id}
          defaultValue=""
          style={{ ...inputStyle, marginTop: 4 }}
        >
          <option value="">Pick a node…</option>
          {options.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.id})
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        style={{
          height: 34,
          padding: "0 12px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          cursor: "pointer",
          flex: "none",
        }}
      >
        Add
      </button>
    </form>
  );
}
