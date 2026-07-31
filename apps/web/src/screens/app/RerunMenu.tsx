import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Icon } from "../../components";
import { api, type GraphVersion } from "../../lib/api";
import { shiftIntoView } from "../../lib/popoverPlacement";

/** Compact relative time from an ISO timestamp (no date lib). Mirrors Runs.tsx's `ago`. */
function ago(iso: string): string {
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Re-run control shared by the Runs list (per row) and the Run detail screen. A primary
 * "Re-run" button re-runs against the LATEST graph (unchanged behaviour); the caret opens
 * a picker to re-run at a SPECIFIC saved version (newer or older) of THIS run's workflow.
 * Versions are loaded lazily on first open. When the run has no known workflowKey (very old
 * runs) the picker is unavailable and only latest re-run is offered.
 *
 * The caret menu also carries "Re-run with debug" — the ONLY place in the app (with the
 * canvas's "Save & run with debug") that sets the API's `debug` flag. That flag now means
 * verbose WORKER logging only: the run detail's per-step rows, which it used to be the way to
 * get, are in every run's Execution log. So this is for a problem you have to read the worker's
 * own output to see. It is deliberately a one-shot action rather than a sticky preference —
 * a toggle left on for weeks raises log volume invisibly.
 */
export function RerunMenu({
  runId,
  workflowKey,
  currentVersion,
  size = "sm",
  label,
  onRerun,
  onError,
}: {
  runId: string;
  workflowKey: string | null;
  /** The version THIS run executed — marked "this run" in the list. */
  currentVersion: number | null;
  size?: "sm" | "md";
  /** When set, the primary button shows this text (run detail); omit for an icon-only
   *  button (the dense Runs list). */
  label?: string;
  /** Called with the new run's id after a successful (re)start. */
  onRerun: (newRunId: string) => void;
  onError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<GraphVersion[] | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /**
   * Horizontal correction so the popover can't grow off the LEFT edge (#511).
   *
   * The menu is `right: 0` at a fixed `minWidth: 272`, which is fine wherever the anchor sits near
   * the right of the screen — the Runs list, and every non-failed run. But a FAILED run also renders
   * "Resume", the action row wraps on a phone, and the Re-run group ends up mid-row: measured on
   * `screens-rundetail--failed` at 390×844, the menu landed at **left: −121**. `global.css` clamps
   * the root with `overflow-x: hidden`, so those 121px cannot be scrolled to — the debug item and
   * every version row lost their left third, "v4 / latest / this run" labels included. Identical at
   * 375; fine at 1440 (left: 1140), so it is the anchor's x, not the content.
   *
   * A translate, not a switch to `position: fixed`: this popover lives in a scrolling list and gets
   * row-tracking for free from being in flow. Fixed would need a scroll listener, and "closes on
   * scroll" is the bug being fixed in `settings/shared.tsx` in the same pass.
   */
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const fit = () => {
      const el = menu.current;
      const anchor = wrap.current;
      if (!el || !anchor) return;
      /**
       * Derive the UNTRANSLATED box from the anchor, never from the menu's own rect.
       *
       * Two wrong versions preceded this one, and both are instructive:
       *
       *  1. `el.style.transform = ""` then measure. That writes to the DOM behind React's back, and
       *     when the recomputed shift equals the current one `setShift` skips the re-render — so the
       *     correction stayed erased. The menu measured left −121 again with the fix in place.
       *  2. Measure `el` and subtract the applied `shift`. Arithmetically sound, but it needs `shift`
       *     in the dependency list, and the menu's rect is not a fixed function of it — translating
       *     the menu changes an ancestor's scrollable width, which nudges layout, which yields a new
       *     shift. Infinite loop (React error #185), and the story rendered nothing at all.
       *
       * The menu is `right: 0` inside `wrap`, so its untranslated right edge IS the anchor's right
       * edge and its width is `offsetWidth` (a transform does not change either). That reads only
       * transform-independent values, so the effect is idempotent and needs no `shift` dependency.
       */
      const a = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      setShift(
        shiftIntoView(
          { left: a.right - width, right: a.right },
          { width: document.documentElement.clientWidth },
        ),
      );
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // `versions` is a dependency because the list arrives async and changes the menu's size.
  }, [open, versions]);

  // Close on an outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    // Lazy-load the version list the first time the menu opens.
    if (next && versions === null && workflowKey) {
      try {
        setVersions(await api.listGraphVersions(workflowKey));
      } catch {
        setVersions([]);
        onError?.("Could not load workflow versions.");
      }
    }
  }

  async function run(
    version: number | undefined,
    e: ReactMouseEvent,
    debug = false,
  ) {
    e.stopPropagation();
    setBusy(true);
    setOpen(false);
    try {
      const { workflowId } = await api.rerun(
        runId,
        version,
        debug ? { debug: true } : undefined,
      );
      onRerun(workflowId);
    } catch {
      onError?.(
        version === undefined
          ? "Could not re-run (this run may predate re-run support)."
          : `Could not re-run at version ${version}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const latest = versions?.[0]?.version ?? null;

  return (
    <span
      ref={wrap}
      // `btn-split` joins the primary and its caret into one control (see components.css). Only
      // meaningful when the caret is actually rendered — a lone button needs no seam handling.
      className={workflowKey ? "btn-split" : undefined}
      style={{ position: "relative", display: "inline-flex" }}
    >
      {/* Primary: re-run against the latest graph (the original behaviour). */}
      <Button
        size={size}
        variant="secondary"
        icon="refresh"
        iconOnly={!label}
        title="Re-run with the same input (latest version)"
        aria-label="Re-run with the same input"
        disabled={busy}
        onClick={(e) => void run(undefined, e)}
      >
        {label}
      </Button>
      {/* Caret: re-run with debug, or at a specific version. */}
      {workflowKey && (
        <Button
          size={size}
          variant="secondary"
          icon="chevron-down"
          iconOnly
          title="Re-run with debug, or at a specific version…"
          aria-label="More re-run options"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={(e) => void toggle(e)}
        />
      )}

      {open && (
        <div
          ref={menu}
          role="menu"
          className="menu-pop"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            transform: shift ? `translateX(${shift}px)` : undefined,
            zIndex: 30,
            // Paired with the translate: on a viewport narrower than the menu, shifting alone can't
            // make it fit, so cap the width too. 272px + two 8px gutters needs 288px of viewport.
            maxWidth: "calc(100vw - 16px)",
            // Wide enough that the debug item's explanation reads as a sentence rather than a
            // column of two-word lines (the version rows never needed the room).
            minWidth: 272,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
            padding: 6,
          }}
        >
          {/* Diagnostics first: the reason someone opens this menu on a run that went wrong.
              The sub-line is the honest description of what the flag costs — a debug run
              executes the flow for real AND logs more, so neither is a surprise after the click. */}
          <button
            type="button"
            role="menuitem"
            onClick={(e) => void run(undefined, e, true)}
            style={{
              display: "block",
              width: "100%",
              padding: "7px 8px",
              border: "none",
              borderRadius: 7,
              background: "transparent",
              color: "var(--ink-1)",
              cursor: "pointer",
              textAlign: "left",
              font: "inherit",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--brand-soft)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Icon name="activity" size={12} strokeWidth={2} />
              <span style={{ fontSize: "var(--text-xs)" }}>
                Re-run with debug
              </span>
            </span>
            <span
              style={{
                display: "block",
                fontSize: 10,
                lineHeight: 1.4,
                color: "var(--ink-3)",
                marginTop: 2,
              }}
            >
              Logs every step verbosely in the worker, for diagnosing a problem
              in the worker's own output — per-step input/output is in the
              Execution log either way. A real run at the latest version: it
              repeats the flow's actions and bills its model calls again.
            </span>
          </button>
          <div
            style={{
              borderTop: "1px solid var(--line)",
              margin: "6px 0",
            }}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              padding: "6px 8px 2px",
            }}
          >
            Re-run at version
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--ink-3)",
              padding: "0 8px 6px",
            }}
          >
            Uses this run's original trigger input.
          </div>
          {versions === null ? (
            <div
              style={{
                padding: "8px",
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
              }}
            >
              Loading…
            </div>
          ) : versions.length === 0 ? (
            <div
              style={{
                padding: "8px",
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
              }}
            >
              No saved versions.
            </div>
          ) : (
            versions.map((v) => {
              const isCurrent = v.version === currentVersion;
              const isLatest = v.version === latest;
              return (
                <button
                  key={v.version}
                  type="button"
                  role="menuitem"
                  onClick={(e) => void run(v.version, e)}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "7px 8px",
                    border: "none",
                    borderRadius: 7,
                    background: "transparent",
                    color: "var(--ink-1)",
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--brand-soft)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    style={{ display: "flex", gap: 6, alignItems: "baseline" }}
                  >
                    <span
                      className="mono"
                      style={{ fontSize: "var(--text-xs)" }}
                    >
                      v{v.version}
                    </span>
                    {isLatest && (
                      <span style={{ fontSize: 10, color: "var(--brand)" }}>
                        latest
                      </span>
                    )}
                    {isCurrent && (
                      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                        this run
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ago(v.createdAt)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </span>
  );
}

/** A small "v{n}" badge (or "—") for showing a run's graph version inline. */
export function VersionBadge({ version }: { version: number | null }) {
  if (version === null)
    return (
      <span
        className="mono"
        style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
      >
        —
      </span>
    );
  return (
    <span
      className="mono"
      title={`Graph version ${version}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: "var(--text-xs)",
        color: "var(--ink-2)",
        background: "var(--brand-soft)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "1px 6px",
      }}
    >
      <Icon name="workflow" size={11} strokeWidth={2} />v{version}
    </span>
  );
}
