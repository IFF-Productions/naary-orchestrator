/**
 * Canvas top bar (redesign: Canvas Authoring Loop) — 56px, --panel, hairline
 * bottom: flame tile (back to where the user came from) · editable workflow
 * name (styled as plain bold text) · mono "<key> · v<N>|draft" meta ·
 * valid/invalid pill (+ issues pill) · the ACTIVE environment chip (real env,
 * colored by envAccent) · right side: status text · "RUN CAP" mono chip (only
 * when the real budget policy sets a per-execution cap) · Build with AI ·
 * feedback · "…" overflow menu (Import / Export / Run input / workflow
 * switcher) · Save · Save & run.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, StatusPill } from "../../components";
import type { GraphSummary } from "../../lib/api";
import { CANVAS_HOME } from "../../lib/canvas-return";
import { attachFeedback, feedbackAvailable } from "../../lib/feedback";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

/**
 * "Send feedback" for the canvas — opens the Sentry User Feedback dialog. The nav drawer's
 * button (NavRail) lives in AppShell, and the canvas is a SIBLING route of /app, so the
 * canvas had no way to report anything from the screen where users spend the most time.
 *
 * Deliberately always mounted rather than an item in the "…" menu: `attachTo` hands the
 * dialog's lifecycle to the SDK, and a menu item unmounts on the very click that opens it
 * (the handler closes the menu), so the cleanup would race the dialog it just created.
 * Renders nothing when Sentry isn't configured at build time.
 */
function CanvasFeedbackButton() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachFeedback(ref.current);
  }, []);
  if (!feedbackAvailable) return null;
  return (
    <button
      ref={ref}
      type="button"
      title="Send feedback"
      aria-label="Send feedback"
      style={{
        width: 34,
        height: 34,
        flex: "none",
        borderRadius: 9,
        border: "1px solid var(--line-2)",
        background: "var(--card)",
        color: "var(--ink-2)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="chat" size={16} />
    </button>
  );
}

export interface TopBarEnv {
  name: string;
  accent: string;
  isProd: boolean;
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.03em",
  color: "var(--ink-3)",
};

export function CanvasTopBar({
  name,
  onNameChange,
  backTo,
  backLabel,
  activeKey,
  version,
  generating,
  graphValid,
  graphError,
  issuesCount,
  issuesSevere,
  hasVerdict,
  showIssues,
  onToggleIssues,
  env,
  runCapUsd,
  status,
  busy,
  maySave,
  saveDeniedTitle,
  showAi,
  onToggleAi,
  showInput,
  onToggleInput,
  onImport,
  onExport,
  workflows,
  currentKeyParam,
  onOpenWorkflow,
  onNewWorkflow,
  onSave,
  onCheck,
  checking,
  onRun,
}: {
  name: string;
  onNameChange: (v: string) => void;
  /** Where the back control goes — the validated `?from=` target, else CANVAS_HOME. */
  backTo?: string;
  /** Its label/tooltip, e.g. "Back to Runs". Defaults to the generic "Back to Naary". */
  backLabel?: string;
  activeKey: string;
  /** Saved version of the open workflow; null = unsaved draft. */
  version: number | null;
  generating: boolean;
  graphValid: boolean;
  graphError?: string | null;
  issuesCount: number;
  issuesSevere: boolean;
  /** A dry-run verdict exists — the panel has something to show even at zero issues (#832). */
  hasVerdict: boolean;
  showIssues: boolean;
  onToggleIssues: () => void;
  /** The active environment (real, from the env store); omit to hide the chip. */
  env?: TopBarEnv | null;
  /** Real per-execution cap from the tenant budget policy; omit when unset. */
  runCapUsd?: number | null;
  status?: string | null;
  busy: boolean;
  maySave: boolean;
  saveDeniedTitle: string;
  showAi: boolean;
  onToggleAi: () => void;
  showInput: boolean;
  onToggleInput: () => void;
  onImport: () => void;
  onExport: () => void;
  workflows: GraphSummary[];
  currentKeyParam: string | null;
  onOpenWorkflow: (key: string) => void;
  onNewWorkflow: () => void;
  onSave: () => void;
  /** Dry run (#832): save, then check config/request/credentials WITHOUT executing a node. */
  onCheck: () => void;
  checking: boolean;
  onRun: () => void;
}) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Element))
        setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header
      style={{
        height: 56,
        flex: "none",
        borderBottom: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: phone ? 8 : 12,
        padding: phone ? "0 10px" : "0 16px",
        position: "relative",
        zIndex: 8,
        minWidth: 0,
      }}
    >
      {/* Back to where the user came from (the validated ?from= target), falling back to /app.
          On desktop it's the brand flame tile; on a phone it's an explicit, labeled pill so a
          user dropped onto the full-screen canvas (e.g. via Simple mode's "Open in Builder") is
          never trapped — the app nav isn't on this route. The LABEL names the destination
          ("Back to Runs") so the control says where it goes rather than just "out". */}
      {phone ? (
        <button
          type="button"
          aria-label={backLabel ?? "Exit to app"}
          title={backLabel ?? "Exit to app"}
          onClick={() => navigate(backTo ?? CANVAS_HOME)}
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 40,
            padding: "0 12px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            cursor: "pointer",
          }}
        >
          <Icon name="arrow-left" size={16} />
          Exit
        </button>
      ) : backTo && backTo !== CANVAS_HOME ? (
        // Arrived from a specific screen ⇒ show a LABELED back control instead of the flame.
        // An icon-only tile can't say where it goes, and "get me back to the run I was
        // reading" is the whole point; the flame stays for a direct visit to the canvas,
        // where there's nothing specific to name.
        <button
          type="button"
          aria-label={backLabel ?? "Back to Naary"}
          title={backLabel ?? "Back to Naary"}
          onClick={() => navigate(backTo)}
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 30,
            padding: "0 10px 0 8px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            fontSize: "var(--text-sm)",
            cursor: "pointer",
            maxWidth: 200,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <Icon name="arrow-left" size={15} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {(backLabel ?? "Back").replace(/^Back to /, "")}
          </span>
        </button>
      ) : (
        <button
          type="button"
          aria-label={backLabel ?? "Back to Naary"}
          title={backLabel ?? "Back to Naary"}
          onClick={() => navigate(backTo ?? CANVAS_HOME)}
          style={{
            width: 28,
            height: 28,
            flex: "none",
            borderRadius: 8,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "radial-gradient(120% 120% at 50% 120%, #ffb347, #f2622e 55%, #c8331f)",
            boxShadow: "0 0 14px -2px rgba(242, 98, 46, 0.6)",
            cursor: "pointer",
            color: "#fff3ec",
            padding: 0,
          }}
        >
          <Icon name="flame" size={16} />
        </button>
      )}

      {/* name (editable, styled as plain bold text) + mono meta. On a phone the name shrinks
          FIRST (so the right cluster's Save/Run stay put) and the mono key·version meta is
          hidden to save the row. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          minWidth: 0,
          flex: phone ? "1 1 auto" : "0 1 auto",
        }}
      >
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Workflow name"
          aria-label="Workflow name"
          className="naary-name-input"
          size={Math.max(8, Math.min(32, name.length || 12))}
          style={{
            border: "1px solid transparent",
            background: "transparent",
            color: "var(--ink)",
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            fontFamily: "var(--font-sans)",
            borderRadius: 7,
            padding: "4px 6px",
            minWidth: phone ? 0 : 60,
            maxWidth: phone ? "100%" : 260,
            width: phone ? "100%" : undefined,
          }}
        />
        {!phone && (
          <>
            <span style={{ color: "var(--ink-3)", flex: "none" }}>/</span>
            <span
              className="mono"
              style={{ ...monoLabel, fontSize: 11, whiteSpace: "nowrap" }}
              title="workflow key · saved version"
            >
              {activeKey} · {version != null ? `v${version}` : "draft"}
            </span>
          </>
        )}
      </div>

      {/* validity + issues — hidden on a phone to keep the bar to one clean row. Both are shown
          on the wider (tablet/desktop) layouts; a save still surfaces validity errors via toast. */}
      {!phone && (
        <StatusPill
          state={generating ? "running" : graphValid ? "done" : "error"}
          label={
            generating
              ? "building…"
              : graphValid
                ? "valid"
                : (graphError ?? "invalid")
          }
        />
      )}
      {/* `hasVerdict` is why this isn't just `issuesCount > 0`: a CLEAN dry run has no issues but
          does have something to say (what it verified, and what it couldn't — #835). Gating on the
          count alone let the user collapse that panel and left them no control to reopen it. */}
      {!phone && !generating && (issuesCount > 0 || hasVerdict) && (
        <button
          type="button"
          onClick={onToggleIssues}
          title={
            issuesCount > 0
              ? "Show details of every issue"
              : "Show what the last check covered"
          }
          className={`pill ${
            issuesCount === 0
              ? "pill-done"
              : issuesSevere
                ? "pill-error"
                : "pill-paused"
          }`}
          style={{ border: "none", cursor: "pointer", flex: "none" }}
        >
          {issuesCount > 0
            ? `⚠ ${issuesCount} issue${issuesCount > 1 ? "s" : ""} `
            : "✓ checked "}
          {showIssues ? "▲" : "▼"}
        </button>
      )}

      {/* active environment chip (real active env — colored by convention) */}
      {!phone && env && (
        <span
          title={`Active environment: ${env.name}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flex: "none",
            fontSize: "var(--text-xs)",
            padding: "3px 10px",
            borderRadius: 999,
            color: env.accent,
            border: `1px solid color-mix(in srgb, ${env.accent} 40%, transparent)`,
            background: `color-mix(in srgb, ${env.accent} 8%, transparent)`,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: env.accent,
              boxShadow: env.isProd ? `0 0 7px ${env.accent}` : undefined,
              flex: "none",
            }}
          />
          {env.name}
        </span>
      )}

      {/* right cluster. On a phone it's flex:none so Save / Save & run / the "…" menu never
          shrink or clip (the workflow name shrinks first instead); on wider layouts it keeps the
          original min-width:0 so it can still shrink if needed. */}
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: phone ? 6 : 10,
          ...(phone ? { flex: "none" } : { minWidth: 0 }),
        }}
      >
        {!phone && status && (
          <span
            title={status}
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {status}
          </span>
        )}

        {/* RUN CAP — only when the budget policy really sets a per-execution cap */}
        {!phone && runCapUsd != null && runCapUsd > 0 && (
          <span
            title="Per-execution budget cap (Usage & budgets policy)"
            style={{ textAlign: "right", flex: "none" }}
          >
            <span
              className="mono"
              style={{
                ...monoLabel,
                display: "block",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Run cap
            </span>
            <span
              className="mono"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--ink-soft)",
                display: "block",
              }}
            >
              ${runCapUsd} / run
            </span>
          </span>
        )}

        {/* Build with AI is hidden on a phone (dense power feature; AI authoring lives in Simple
            mode + the overflow menu) so Save / Save & run stay on the single row. */}
        {!phone && (
          <Button variant="secondary" disabled={busy} onClick={onToggleAi}>
            {showAi ? "Close AI" : "✨ Build with AI"}
          </Button>
        )}

        {/* Send feedback. Desktop/tablet only — the phone bar is a protected single row (same
            reason Build with AI is hidden there), and the nav drawer's button covers phones. */}
        {!phone && <CanvasFeedbackButton />}

        {/* overflow menu: import / export / run input / workflow switcher */}
        <div ref={menuRef} style={{ position: "relative", flex: "none" }}>
          <button
            type="button"
            aria-label="More actions"
            aria-expanded={menuOpen}
            title="More actions"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="more" size={16} />
          </button>
          {menuOpen && (
            <div
              className="menu-pop"
              role="menu"
              aria-label="Canvas actions"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 6px)",
                width: 240,
                background: "var(--panel)",
                border: "1px solid var(--line-mid)",
                borderRadius: 12,
                boxShadow: "var(--shadow-raised)",
                padding: 6,
                zIndex: 40,
              }}
            >
              {[
                { label: "Import…", action: onImport, disabled: busy },
                {
                  label: "Export",
                  action: onExport,
                  disabled: busy || !graphValid,
                },
                {
                  label: showInput ? "Hide run input" : "Run input…",
                  action: onToggleInput,
                  disabled: busy,
                },
              ].map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setMenuOpen(false);
                    it.action();
                  }}
                  className="naary-menu-item"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "transparent",
                    color: it.disabled ? "var(--ink-3)" : "var(--ink)",
                    fontSize: "var(--text-sm)",
                    cursor: it.disabled ? "default" : "pointer",
                  }}
                >
                  {it.label}
                </button>
              ))}

              <div
                style={{
                  borderTop: "1px solid var(--line)",
                  margin: "6px 0",
                }}
              />
              <div
                className="mono"
                style={{
                  ...monoLabel,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  padding: "4px 10px 6px",
                }}
              >
                Open workflow
              </div>
              <button
                type="button"
                role="menuitem"
                className="naary-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onNewWorkflow();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  color: "var(--brand)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  cursor: "pointer",
                }}
              >
                + New workflow
              </button>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {workflows.map((w) => {
                  const current = currentKeyParam === w.workflowKey;
                  return (
                    <button
                      key={w.workflowKey}
                      type="button"
                      role="menuitem"
                      className="naary-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenWorkflow(w.workflowKey);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        padding: "7px 10px",
                        borderRadius: 8,
                        border: "none",
                        background: current
                          ? "var(--brand-soft)"
                          : "transparent",
                        color: "var(--ink)",
                        fontSize: "var(--text-sm)",
                        cursor: "pointer",
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
                        style={{ ...monoLabel, flex: "none" }}
                      >
                        v{w.version}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <Button
          variant="secondary"
          disabled={busy || !graphValid || !maySave}
          title={maySave ? undefined : saveDeniedTitle}
          onClick={onSave}
        >
          Save
        </Button>
        {/* Sits before "Save & run" because it is the cheap answer to the same question, and it
            is the one to reach for FIRST on a flow with real side effects. */}
        <Button
          variant="secondary"
          disabled={busy || checking || !graphValid || !maySave}
          title={
            maySave
              ? "Saves, then checks every integration node's config, request and connection — without running anything"
              : saveDeniedTitle
          }
          onClick={onCheck}
        >
          {checking ? "Checking…" : "Check flow"}
        </Button>
        <Button
          variant="primary"
          disabled={busy || checking || !graphValid || !maySave}
          title={maySave ? undefined : saveDeniedTitle}
          onClick={onRun}
        >
          {busy ? "Running…" : "Save & run"}
        </Button>
      </div>
    </header>
  );
}
