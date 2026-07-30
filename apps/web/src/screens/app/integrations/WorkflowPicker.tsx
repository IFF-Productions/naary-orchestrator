/**
 * Filterable workflow picker for hosted-endpoint registration (form / chat / webhook).
 *
 * Registration used to ask for a workflow KEY typed by hand, which fails in two ways a user
 * can't see coming: a typo or an unsaved key 404s ("No graph seeded for workflowKey '…'"),
 * and — for forms and chat — a workflow whose ENTRY node isn't the matching trigger is
 * rejected on submit, because that is what extractFormDefinition / extractChatDefinition
 * require. Both are knowable up front: the workflow list carries `entryType`.
 *
 * So this picker only ever offers workflows that would actually register, and filters as you
 * type (a plain <select> can't be filtered, and a tenant can have hundreds of workflows).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components";
import type { GraphSummary } from "../../../lib/api";
import { fieldStyle } from "./shared";

export interface WorkflowPickerProps {
  /** Every saved workflow in the active environment (already permission-filtered by the API). */
  workflows: GraphSummary[];
  /** Selected workflow key ("" = none). */
  value: string;
  onChange: (workflowKey: string) => void;
  /**
   * Restrict to workflows whose ENTRY node is this type — the server's own eligibility rule.
   * Omit (webhooks) to offer every workflow: any graph can be triggered by a webhook.
   */
  entryType?: string;
  /** What this kind of endpoint needs, for the empty state, e.g. "a Form trigger". */
  requires?: string;
  /** null while the list is still loading, so "none yet" isn't claimed prematurely. */
  loading?: boolean;
}

/** Does this workflow match the free-text filter? Matches the name OR the key, case-insensitively. */
function matches(w: GraphSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    w.name.toLowerCase().includes(q) || w.workflowKey.toLowerCase().includes(q)
  );
}

export function WorkflowPicker({
  workflows,
  value,
  onChange,
  entryType,
  requires,
  loading = false,
}: WorkflowPickerProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Only the workflows this endpoint could actually be registered for.
  const eligible = useMemo(
    () =>
      entryType
        ? workflows.filter((w) => w.entryType === entryType)
        : workflows,
    [workflows, entryType],
  );
  const shown = useMemo(
    () => eligible.filter((w) => matches(w, query)),
    [eligible, query],
  );
  const selected = eligible.find((w) => w.workflowKey === value) ?? null;

  // Close on an outside click / Escape, like the canvas's overflow menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row inside the filtered list as it shrinks.
  useEffect(() => {
    setActive(0);
  }, []);

  function choose(w: GraphSummary) {
    onChange(w.workflowKey);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (shown.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + delta + shown.length) % shown.length);
      return;
    }
    if (e.key === "Enter" && open && shown[active]) {
      e.preventDefault();
      choose(shown[active]);
    }
  }

  if (loading) {
    // Render the REAL control, disabled — not a text substitute. Replacing the input with a
    // sentence removes the field from the dialog until a network call returns: the layout jumps
    // when it arrives, and there is nothing to focus or tab to meanwhile. Keeping the same
    // element (and the same test id) also means a slow list reads as "not ready yet" rather than
    // "not there", which is what made the e2e wait its whole 30s budget on an absent node and
    // then report a click timeout instead of a slow fetch.
    return (
      <input
        role="combobox"
        data-testid="workflow-picker"
        aria-expanded={false}
        aria-busy="true"
        disabled
        readOnly
        value=""
        placeholder="Loading workflows…"
        style={fieldStyle}
      />
    );
  }

  // Nothing eligible: say WHY, and distinguish "no workflows at all" from "none of the right
  // shape" — those need different fixes, and the old copy implied the first for both.
  if (eligible.length === 0) {
    // Carries the test id too, and `data-empty` to say WHICH state this is.
    //
    // #923 gave the loading branch the id so a slow list would read as "not ready" rather than
    // "not there" — and left this branch without one, which is the same defect one branch over.
    // An empty list then looked identical to a missing component: an e2e waited its full budget
    // and reported `element(s) not found`, which points at the picker when the real answer is
    // "this tenant has no eligible workflows" (in CI: seeding didn't land). A caller can now tell
    // the two apart, and nothing has to infer absence from silence.
    return (
      <div
        data-testid="workflow-picker-empty"
        data-empty={workflows.length === 0 ? "no-workflows" : "none-eligible"}
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          padding: "8px 0",
        }}
      >
        {workflows.length === 0
          ? "No saved workflows yet — save one on the canvas first, then it'll appear here."
          : `None of your workflows start with ${requires ?? "the required trigger"}. Open one on the canvas and make that its first node.`}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          role="combobox"
          data-testid="workflow-picker"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder={
            selected
              ? `${selected.name} (${selected.workflowKey})`
              : "Search workflows…"
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{
            ...fieldStyle,
            paddingRight: 30,
            // A chosen workflow shows as solid placeholder text, so the field reads as
            // "this is selected" rather than an empty box the user must re-type into.
            ...(selected && !query
              ? { color: "var(--ink)", fontWeight: "var(--weight-semibold)" }
              : null),
          }}
        />
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: 9,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--ink-3)",
            pointerEvents: "none",
            display: "flex",
          }}
        >
          <Icon name="chevron-down" size={14} />
        </span>
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: "auto",
            background: "var(--panel)",
            border: "1px solid var(--line-mid)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-raised)",
            padding: 4,
          }}
        >
          {shown.length === 0 ? (
            <div
              style={{
                padding: "8px 10px",
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              No workflow matches “{query.trim()}”.
            </div>
          ) : (
            shown.map((w, i) => (
              <button
                key={w.workflowKey}
                type="button"
                role="option"
                aria-selected={w.workflowKey === value}
                // Stable hook for e2e: the visible label is the NAME, but a test knows the KEY.
                // (Before this was a combobox it was a <select> and specs used option[value].)
                data-workflow-key={w.workflowKey}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(w)}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: "var(--radius-xs)",
                  padding: "7px 10px",
                  fontSize: "var(--text-sm)",
                  color: "var(--ink)",
                  background:
                    i === active
                      ? "var(--card-2)"
                      : w.workflowKey === value
                        ? "var(--brand-soft)"
                        : "transparent",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.name}
                </span>
                <span
                  className="mono"
                  style={{
                    flex: "none",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  {w.workflowKey}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
