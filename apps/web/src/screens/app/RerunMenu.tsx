import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, Icon } from "../../components";
import { api, type GraphVersion } from "../../lib/api";

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

  async function run(version: number | undefined, e: ReactMouseEvent) {
    e.stopPropagation();
    setBusy(true);
    setOpen(false);
    try {
      const { workflowId } = await api.rerun(runId, version);
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
    <span ref={wrap} style={{ position: "relative", display: "inline-flex" }}>
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
      {/* Caret: pick a specific version to re-run at. */}
      {workflowKey && (
        <Button
          size={size}
          variant="secondary"
          icon="chevron-down"
          iconOnly
          title="Re-run at a specific version…"
          aria-label="Re-run at a specific version"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={(e) => void toggle(e)}
        />
      )}

      {open && (
        <div
          role="menu"
          className="menu-pop"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 30,
            minWidth: 210,
            maxHeight: 280,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
            padding: 6,
          }}
        >
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
