/**
 * Canvas top bar (redesign: Canvas Authoring Loop) — 56px, --panel, hairline
 * bottom: flame tile (back to where the user came from) · editable workflow
 * name (styled as plain bold text) · mono "<key> · v<N>|draft" meta ·
 * valid/invalid pill (+ issues pill) · the ACTIVE environment chip (real env,
 * colored by envAccent) · right side: status text · "RUN CAP" mono chip (only
 * when the real budget policy sets a per-execution cap) · Build with AI ·
 * feedback · "…" overflow menu (Import / Export / Run input / workflow
 * switcher) · Save · Save & run.
 *
 * That list is wider than the row on anything but a desktop, and the two narrower tiers pay for
 * it differently — which is the thing to keep straight when editing this file:
 *
 *  - `compact` (≤1024px, tablet and down) gives up LABELS AND REFERENCE TEXT, never controls: the
 *    mono `key · vN` meta and the RUN CAP chip go, "✨ Build with AI" becomes its icon, "Check
 *    flow" becomes "Check", and the issues / `± changes` pills use their short glyph forms (#989).
 *  - `phone` (≤640px) has ~440px less to work with, so it also moves ACTIONS: Save and "Check
 *    flow" go INTO the "…" menu and only the name + "Save & run" stay in the bar (#964).
 *
 * `compact` is a superset of `phone`, so a compact rule reaches a phone too; the phone-only rules
 * stay on `phone`.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, StatusPill } from "../../components";
import type { GraphSummary } from "../../lib/api";
import { CANVAS_HOME } from "../../lib/canvas-return";
import { attachFeedback, feedbackAvailable } from "../../lib/feedback";
import {
  BELOW_RAIL_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../../lib/useMediaQuery";

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

/**
 * Text for assistive tech only — off-screen, zero layout cost, still in the accessibility tree.
 *
 * Used where the COMPACT tier shortens a label that a screen reader still needs in full. Note
 * `aria-label` is NOT the tool for that here: the element carrying the truncated text is a plain
 * `<span>` (role `generic`), and ARIA prohibits naming a generic element — support is
 * inconsistent and axe flags it. On the two PILLS, which are real `<button>`s, `aria-label` IS
 * authoritative and is what they use instead.
 *
 * `clip-path` rather than `width/height: 1px; overflow: hidden` so the text is never read as a
 * one-pixel line by a braille display, and `white-space: nowrap` so it can't wrap into a
 * scrollbar-triggering box.
 */
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

/** Rule between groups in the "…" menu (also used above the workflow switcher). */
const menuDivider: React.CSSProperties = {
  borderTop: "1px solid var(--line)",
  margin: "6px 0",
};

/**
 * One row of the "…" menu. Typed rather than inferred from the literal because the list is now
 * assembled conditionally (the phone-only Save / Check flow rows are spread in), and a widened
 * union would quietly drop `hint` on the items that carry one.
 */
interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Sub-label — the honest cost of the action, or WHY it is disabled. */
  hint?: string;
  /** Draw a rule after this row. */
  endsGroup?: boolean;
}

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
  verdictOk,
  showIssues,
  onToggleIssues,
  canReview,
  showReview,
  onToggleReview,
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
  onRunDebug,
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
  /** …and whether that verdict was a PASS. Zero issues is not the same as a clean check: a check
   *  that failed to run also has zero issues, and must not render as success. */
  verdictOk?: boolean;
  showIssues: boolean;
  onToggleIssues: () => void;
  /** There is a baseline AND unsaved work — i.e. the review panel has something to say. */
  canReview?: boolean;
  showReview?: boolean;
  onToggleReview?: () => void;
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
  /** Same as onRun, but starts the run with diagnostics on (the API's `debug` flag). Lives in
   *  the overflow menu, not next to "Save & run", because it is the occasional answer to "why
   *  did that step do that", not the everyday one. */
  onRunDebug: () => void;
}) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  /**
   * ≤1024px — phone AND tablet, the same range the shell collapses its nav in. Everything the
   * phone hides is `!phone`; `compact` is the WIDER rule, for the things a tablet can afford to
   * shorten but not to lose (#989). Deliberately a superset of `phone`, so a rule written here
   * reads the same on both and there is no third branch to keep in step.
   */
  const compact = useMediaQuery(BELOW_RAIL_QUERY);
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
        // The row has up to seven gaps; 12 → 8 across a tablet is ~28px back, free of any
        // control. Phone keeps its own tighter padding.
        gap: compact ? 8 : 12,
        padding: phone ? "0 10px" : compact ? "0 12px" : "0 16px",
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
          FIRST (so the right cluster's "…" / Save & run stay put) and the mono key·version meta
          is hidden to save the row. It shrinks, but it must not VANISH: `minWidth: 0` against a
          `flex: none` cluster meant the name absorbed every pixel of shortfall and ended up 14px
          wide — its own padding — at 390px (#964). The cluster is what got smaller instead.

          As of #989 the meta's hiding runs to the whole `compact` range, because it is the single
          most expensive thing in the bar (~210px for "pagerduty-incident-triage · v19", nowrap)
          and the only one that is pure reference: never actionable, its own tooltip says it never
          changes, and it is still there on desktop. Buying it back is what lets a tablet keep
          every control. */}
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
            maxWidth: phone ? "100%" : compact ? 220 : 260,
            width: phone ? "100%" : undefined,
          }}
        />
        {!compact && (
          <>
            <span style={{ color: "var(--ink-3)", flex: "none" }}>/</span>
            <span
              className="mono"
              style={{ ...monoLabel, fontSize: 11, whiteSpace: "nowrap" }}
              // The old title just restated the two labels. It sits inches from a live-editable
              // name and does NOT follow it, which reads as a bug unless something says why —
              // so say why, and only for a SAVED workflow, since on a draft the key does track
              // the name and claiming otherwise would be the opposite lie.
              title={
                version != null
                  ? `Workflow key: ${activeKey} — permanent.\n\n` +
                    "Renaming the workflow deliberately does NOT change it. Schedules, webhook " +
                    "URLs, sub-workflow references and API/CLI callers all address this workflow " +
                    "by its key; changing it would break them silently."
                  : "Workflow key · saved version. The key comes from the name and is fixed when you first save — after that, renaming won't change it."
              }
            >
              {activeKey} · {version != null ? `v${version}` : "draft"}
            </span>
          </>
        )}
      </div>

      {/* validity + issues — hidden on a phone to keep the bar to one clean row. Both are shown
          on the wider (tablet/desktop) layouts.

          The pill is NOT dropped at tablet, unlike its neighbours: it is the only visible answer
          to "why is Save disabled". The fallback this comment used to claim — "a save still
          surfaces validity errors via toast" — does not exist: `save()` puts the message into
          `status`, not a toast, and Save is itself disabled while the graph is invalid, so it
          cannot be pressed to get there.

          Its LABEL is bounded there instead. `graphError` is the one piece of unbounded text left
          in the bar, and a pill cannot shrink: "Start node has no outgoing edge" — 31 characters,
          not a pathological one — renders a 202px pill. With EVERYTHING ELSE in this tier already
          paid for, that alone still put 768px 25px over (drop the `compact ? "invalid"` branch
          below and re-run `responsive-audit.mjs --width 768` on `TabletInvalid` to reproduce);
          834 fits either way, so the bound is what makes the rest of the compact band safe rather
          than only the iPad-portrait one. At compact the pill states the STATE and the message
          rides alongside it.

          It rides in `srOnly` text, NOT only in `title`. A `title` is a pointer affordance: it
          needs a hover, which a touch screen does not have — and the compact tier IS the touch
          tier, so "the detail is in the tooltip" would mean the reason the graph is invalid is
          unavailable to exactly the users this tier was built for, sighted or not. The off-screen
          copy is in the accessibility tree at every width and costs no layout. `title` stays for
          the pointer case. */}
      {!phone && (
        <span
          title={!graphValid && graphError ? graphError : undefined}
          style={{ flex: "none", display: "inline-flex", alignItems: "center" }}
        >
          <StatusPill
            state={generating ? "running" : graphValid ? "done" : "error"}
            label={
              generating
                ? "building…"
                : graphValid
                  ? "valid"
                  : compact
                    ? "invalid"
                    : (graphError ?? "invalid")
            }
          />
          {compact && !generating && !graphValid && graphError && (
            <span style={srOnly}>{graphError}</span>
          )}
        </span>
      )}
      {/* `hasVerdict` is why this isn't just `issuesCount > 0`: a CLEAN dry run has no issues but
          does have something to say (what it verified, and what it couldn't — #835). Gating on the
          count alone let the user collapse that panel and left them no control to reopen it.

          SHOWN ON A PHONE TOO, unlike its neighbours. Reported as: a run failed on an unresolved
          input, the run detail named the node and the field — and the canvas offered no way to see
          or fix it. The lint had found it; every surface for it was just unreachable on a phone.
          The pill was hidden here, the node's ⚠ carries its text in a `title` (a hover tooltip, so
          nothing on touch), and the dock banner that DOES spell it out is reached by selecting the
          node — which is what this panel's rows do. So one hidden control was hiding the whole
          path. The neighbours stay hidden because they have another surface: validity re-appears
          as a toast on save, and the env is on the app shell's own chip. A broken reference has
          none, and it is the single most likely reason a saved workflow fails at run time.

          It keeps the bar to one row by shrinking rather than by disappearing: `⚠ 3` on a phone
          against "⚠ 3 issues ▼" elsewhere. */}
      {!generating && (issuesCount > 0 || hasVerdict) && (
        <button
          type="button"
          onClick={onToggleIssues}
          // A button's accessible name is its CONTENT, and at compact that content is `⚠ 3` — or,
          // for a verdict, a bare `✓` / `✗` that names nothing at all. `title` does not rescue it:
          // a title is only consulted as a name when there is no content, and there is. So the
          // name is stated outright. Given at EVERY width, not just compact — the desktop content
          // ends in a `▼` glyph that is chrome, not name, and one name is easier to keep true
          // than two.
          aria-label={
            issuesCount > 0
              ? `${issuesCount} issue${issuesCount > 1 ? "s" : ""} found`
              : verdictOk
                ? "Check passed"
                : "Check failed"
          }
          aria-expanded={showIssues}
          title={
            issuesCount > 0
              ? "Show details of every issue"
              : verdictOk
                ? "Show what the last check covered"
                : "The check could not be completed — open for the reason"
          }
          className={`pill ${
            issuesCount > 0
              ? issuesSevere
                ? "pill-error"
                : "pill-paused"
              : verdictOk
                ? "pill-done"
                : "pill-error"
          }`}
          style={{ border: "none", cursor: "pointer", flex: "none" }}
        >
          {/* The short glyph form runs to the whole `compact` range, not just a phone (#989): at
              834px "⚠ 3 issues ▼" is 88px and "⚠ 3" is ~40. Shortening a LABEL is the cheap
              trade; hiding the pill is the expensive one this file spent a paragraph above
              refusing to make. What shrinks is the VISIBLE label only — the `aria-label` above
              carries the same sentence at every width, so the trade costs pixels, not meaning. */}
          {issuesCount > 0
            ? compact
              ? `⚠ ${issuesCount}`
              : `⚠ ${issuesCount} issue${issuesCount > 1 ? "s" : ""} `
            : verdictOk
              ? compact
                ? "✓"
                : "✓ checked "
              : compact
                ? "✗"
                : "✗ check failed "}
          {!compact && (showIssues ? "▲" : "▼")}
        </button>
      )}

      {/* "Review changes" — what a save would persist, as a diff against the last saved version.
          Sits next to the issues pill because they answer the two questions before saving: what is
          wrong, and what is different. Shown on a phone for the same reason the issues pill is —
          an AI edit rewrites the whole graph, and reading it back node by node is not a review. */}
      {!generating && canReview && onToggleReview && (
        <button
          type="button"
          onClick={onToggleReview}
          // Same argument as the issues pill: at compact this button's entire content is `±`, so
          // without a name of its own its accessible name is the mathematical-plus-minus sign.
          // `title` cannot stand in — a button that HAS content never falls back to it.
          aria-label="Review changes"
          aria-expanded={showReview}
          title="See what changed since the last save"
          className="pill"
          style={{
            border: "none",
            cursor: "pointer",
            flex: "none",
            background: "var(--card)",
            color: "var(--ink-2)",
          }}
        >
          {compact ? "±" : "± changes "}
          {!compact && (showReview ? "▲" : "▼")}
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

      {/* right cluster — three different rules, one per tier.

          PHONE: flex:none, so "Save & run" and the "…" menu never shrink or clip (the workflow
          name shrinks first instead). That is only safe because the phone cluster is SHORT — two
          controls. It cannot shrink, so whatever it contains it takes, and the header's overflow
          goes off the right edge under a root that is `overflow-x: hidden` (#511's trap): not
          clipped-but-scrollable, just gone. Anything added here must be `!phone` unless the row
          is measured again.

          DESKTOP: the original min-width:0, so it can still shrink if needed.

          COMPACT: neither. It GROWS into the free space (`flex: 1 1 auto`, contents right-aligned)
          and its `minWidth: 0` is dropped so the automatic min-content floor applies (#989).

          That floor is the whole fix at tablet. `minWidth: 0` let the CLUSTER shrink past buttons
          that cannot themselves shrink, so the difference left the right edge instead of pushing
          back on the row: measured at 834px the cluster was 276px around 447px of buttons and
          "Save & run" ended at 974. With the floor, the shortfall goes to the things that CAN
          give — the status text first, then the workflow name down to its 60px floor — and every
          action stays on screen. It is the same conclusion as the phone rule (the name yields
          before a control does), reached without having to move an action out of the bar.

          `marginLeft: auto` has to go with it at compact: an auto margin eats ALL positive free
          space before flex-grow is even considered, so keeping it would pin the cluster at its
          floor and leave the status text at zero width at every compact size.
          `justifyContent: flex-end` is what keeps the buttons against the right edge once the
          cluster is the elastic one. */}
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          // Deliberately NOT tightened at compact the way the header's gap is: these are 34px
          // icon buttons, and 10px is the spacing that keeps a 44px touch target growable without
          // overlapping its neighbour (the responsive audit's `safe` rule). Buying row width by
          // crowding touch targets turns a near-miss into a WRONG action.
          gap: phone ? 6 : 10,
          ...(phone
            ? { flex: "none" }
            : compact
              ? { marginLeft: 0, flex: "1 1 auto", justifyContent: "flex-end" }
              : { minWidth: 0 }),
        }}
      >
        {/* `status` is the ONLY channel for "Save failed." / "Run failed." / an import error —
            none of them is toasted, and `save()` routes "Graph is not runnable." through it too —
            so it is NOT one of the things a narrower layout may drop.

            It is also the only child of this cluster that can shrink (it is `overflow: hidden`,
            so its min-content is 0), which means it absorbs the row's shortfall first and can
            still reach zero width on a full tablet bar. That is the honest trade: a sentence is
            the right thing to lose before a button, and `title` keeps the full text one hover
            away. The tighter cap is for the other direction — with the cluster's min-content floor
            now doing the pushing back, an unbounded 260px sentence would take the room out of the
            workflow name instead. */}
        {!phone && status && (
          <span
            title={status}
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              maxWidth: compact ? 150 : 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              // `width: 0` is what makes the cluster's min-content floor land on the BUTTONS and
              // not on this sentence. `overflow: hidden` alone is not enough, and neither is a
              // zero flex-basis: both leave the parent's min-content contribution computed from
              // the text (clamped to `maxWidth`), which held the cluster 150px wider than its
              // buttons and pushed the shortfall onto the workflow name instead — measured, the
              // name sat at its 60px floor while this sentence kept a full 150. A definite
              // `width` overrides that contribution; `flex: 1 1 150px` is what grows it back to
              // readable as soon as the row has room (0 at 834px, 135 at 1024px).
              ...(compact
                ? { width: 0, flex: "1 1 150px", minWidth: 0 }
                : null),
            }}
          >
            {status}
          </span>
        )}

        {/* RUN CAP — only when the budget policy really sets a per-execution cap, and only from
            desktop up (#989). Two mono lines for ~69px, and unlike its neighbours it is neither a
            control nor a state of THIS workflow: it restates a tenant policy that Settings →
            Usage & budgets owns and that no action here can change. */}
        {!compact && runCapUsd != null && runCapUsd > 0 && (
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
            mode) so Save / Save & run stay on the single row.

            On a TABLET it loses its LABEL, not its place (#989): the full button is 125px, the
            icon 34, and AI authoring is the differentiating feature of this screen — the last
            thing to make unreachable at a width people really do author on. `aria-label` +
            `title` carry the name a screen reader and a pointer would otherwise lose, and the
            toggled state ("Close AI") is in both, so the icon is never ambiguous. */}
        {!phone &&
          (compact ? (
            <button
              type="button"
              aria-label={showAi ? "Close AI" : "Build with AI"}
              title={showAi ? "Close AI" : "Build with AI"}
              aria-pressed={showAi}
              disabled={busy}
              onClick={onToggleAi}
              style={{
                width: 34,
                height: 34,
                flex: "none",
                borderRadius: 9,
                border: `1px solid ${showAi ? "var(--brand)" : "var(--line-2)"}`,
                background: showAi ? "var(--brand-soft)" : "var(--card)",
                color: showAi ? "var(--brand)" : "var(--ink-2)",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.5 : 1,
                fontSize: 15,
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✨
            </button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={onToggleAi}>
              {showAi ? "Close AI" : "✨ Build with AI"}
            </Button>
          ))}

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
              {(
                [
                  // #964: on a phone Save and "Check flow" are HERE, not in the bar — measured at
                  // 390px the bar could not hold them. The name input was down to 14px (its own
                  // padding: the workflow you are editing was not on screen at all) and
                  // "Save & run" ran 22–109px past the right edge, under a root that is
                  // `overflow-x: hidden`, so the primary CTA could not even be scrolled to. The
                  // name and the one CTA win the row; the two secondary actions join the menu that
                  // already holds the less-frequent ones.
                  //
                  // `saveDeniedTitle` rides along as `hint`: a menu row has no `title` to hover,
                  // and on a touch screen a hover tooltip is nothing — so the RBAC reason a save is
                  // refused would otherwise have disappeared on exactly the layout that hides the
                  // button. Same for "Checking…": the bar's `status` text is desktop-only, so
                  // without the label swap a phone user gets no sign a check is running at all.
                  ...(phone
                    ? [
                        {
                          label: "Save",
                          hint: maySave ? undefined : saveDeniedTitle,
                          action: onSave,
                          disabled: busy || !graphValid || !maySave,
                        },
                        {
                          label: checking ? "Checking…" : "Check flow",
                          hint: maySave
                            ? "Saves, then checks every integration node's config, request and connection — without running anything"
                            : saveDeniedTitle,
                          action: onCheck,
                          disabled: busy || checking || !graphValid || !maySave,
                          endsGroup: true,
                        },
                      ]
                    : []),
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
                  // Diagnostics: a normal "Save & run" PLUS the API's per-run `debug` flag. Gated
                  // exactly like "Save & run" (it saves first). The hint is the honest cost — it is
                  // a real run, and it produces more log output than a plain one.
                  {
                    label: "Save & run with debug",
                    // The per-step rows are in every run's Execution log now, so this flag no
                    // longer changes that screen — it turns on verbose WORKER logging. Claiming
                    // otherwise would have people tick it looking for a difference that isn't
                    // there.
                    hint: "Logs every step verbosely in the worker, for diagnosing a problem in the worker's own output. Runs the flow for real. (Per-step input/output is in the Execution log either way.)",
                    action: onRunDebug,
                    disabled: busy || checking || !graphValid || !maySave,
                  },
                ] satisfies MenuItem[]
              ).map((it) => (
                <Fragment key={it.label}>
                  <button
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
                    {it.hint && (
                      <span
                        style={{
                          display: "block",
                          fontSize: "var(--text-2xs)",
                          lineHeight: 1.4,
                          color: "var(--ink-3)",
                          marginTop: 2,
                          whiteSpace: "normal",
                        }}
                      >
                        {it.hint}
                      </span>
                    )}
                  </button>
                  {it.endsGroup && <div style={menuDivider} />}
                </Fragment>
              ))}

              <div style={menuDivider} />
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

        {/* Save and "Check flow" are BUTTONS only from tablet up; on a phone they are rows in the
            "…" menu above, because the bar is not wide enough for all three plus a readable name
            (#964). "Save & run" stays — it is the primary CTA, and the one action worth the room. */}
        {!phone && (
          <Button
            variant="secondary"
            disabled={busy || !graphValid || !maySave}
            title={maySave ? undefined : saveDeniedTitle}
            onClick={onSave}
          >
            Save
          </Button>
        )}
        {/* Sits before "Save & run" because it is the cheap answer to the same question, and it
            is the one to reach for FIRST on a flow with real side effects. */}
        {!phone && (
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
            {/* At compact the label is just "Check" (#989) — 40px back, and "flow" is the one word
                in it that carries nothing the `title` above does not already spell out. The
                `compact` branch is only reachable from tablet down to 641px, since below that
                this button is not in the bar at all (#964). */}
            {checking ? "Checking…" : compact ? "Check" : "Check flow"}
          </Button>
        )}
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
