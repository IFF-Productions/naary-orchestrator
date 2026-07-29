// Settings screen (redesign — _design-reference/redesign/Naary Settings.dc.html).
// An in-screen left sub-nav (Secrets / Variables / Notifications / Experience) with a
// content pane; the active item carries the inset ember bar. Deep-link a section via
// `?section=`. The app shell provides the chrome — this is the content region only.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Environment, UnauthorizedError } from "../../lib/api";
import {
  BELOW_RAIL_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../../lib/useMediaQuery";
import { ExperienceSection } from "./settings/ExperienceSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { SecretsSection } from "./settings/SecretsSection";
import { TemplatesSection } from "./settings/TemplatesSection";
import { TurnstileSection } from "./settings/TurnstileSection";
import { VariablesSection } from "./settings/VariablesSection";

const SECTIONS = [
  {
    id: "secrets",
    label: "Secrets",
    icon: "M15 7a4 4 0 1 0-3.5 6.9L14 16h2v2h2v2h3v-3l-4.5-4.5A4 4 0 0 0 15 7z",
  },
  {
    id: "variables",
    label: "Variables",
    icon: "M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1",
  },
  {
    id: "templates",
    label: "Content templates",
    icon: "M4 5h16v4H4zM4 11h7v8H4zM13 11h7v8h-7z",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  },
  {
    id: "botprotection",
    label: "Bot protection & domains",
    icon: "M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7zM9.5 12l1.8 1.8L15 10",
  },
  {
    id: "experience",
    label: "Experience",
    icon: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4v4M6 10v4M12 16v4",
  },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function isSectionId(v: string | null): v is SectionId {
  return SECTIONS.some((s) => s.id === v);
}

/** Screen-local styles inline styles can't express (hover rows, fade-in, matrix cells). */
const LOCAL_CSS = `
.naary-set-fade{animation:naaryFadeUp .25s ease;}
.naary-set-row{transition:background .12s;}
.naary-set-row:hover{background:var(--hover);}
.naary-set-menu-item{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--ink);font-family:var(--font-sans);font-size:12.5px;padding:8px 10px;border-radius:7px;cursor:pointer;}
.naary-set-menu-item:hover{background:var(--hover);}
.naary-var-cell{width:100%;min-width:0;height:30px;font-size:12px;color:var(--ink-2);background:transparent;border:1px solid transparent;border-radius:7px;padding:0 7px;transition:border-color .12s,background .12s;}
.naary-var-cell::placeholder{color:var(--ink-faint);}
.naary-var-cell:hover{border-color:var(--line-2);}
.naary-var-cell:focus{outline:none;border-color:var(--brand);background:var(--surface);color:var(--ink);}
/* PHONE (#511). Measured at 390px: each variable cell was a 258x30 box — 30px is under the 44px
   touch minimum the rest of the app already holds to (the .btn-icon rule in components.css), and
   these are the screen's ONLY editable controls. On phone VariablesSection already stacks each
   cell onto its own labelled line, so the height simply grows the card; nothing can overlap.
   The type goes to 16px because iOS Safari zooms the page in when you focus an input under 16px,
   and that zoom is exactly what global.css's layout-viewport clamp exists to prevent. The resting
   border comes back for the same reason the label did: stacked in a card these read as text, not
   fields, and hover — the only thing that revealed the box — does not exist on a touch screen. */
@media (max-width: 640px){
  .naary-var-cell{height:44px;font-size:16px;border-color:var(--line);}
}
`;

export function Settings() {
  const phone = useMediaQuery(PHONE_QUERY);
  // At <=1024 (phone + tablet) the left sub-nav becomes a wrapping chip row above
  // the content; only on desktop does it stay a sticky vertical rail.
  const belowRail = useMediaQuery(BELOW_RAIL_QUERY);
  const [params, setParams] = useSearchParams();
  const rawSection = params.get("section");
  const section: SectionId = isSectionId(rawSection) ? rawSection : "secrets";

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenantId(me.tenantId);
        const list = await api.listEnvironments(me.tenantId);
        if (!live) return;
        setEnvs(list);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Sign in to view workspace settings."
              : "Could not reach the control plane (apps/api on :3000).",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  function pick(id: SectionId) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("section", id);
      return next;
    });
  }

  const nav = (
    <nav
      aria-label="Settings sections"
      style={
        belowRail
          ? {
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 18,
            }
          : {
              width: 190,
              flex: "none",
              position: "sticky",
              top: 20,
              alignSelf: "flex-start",
            }
      }
    >
      {SECTIONS.map((s) => {
        const active = s.id === section;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => pick(s.id)}
            aria-current={active ? "true" : undefined}
            style={{
              all: "unset",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              gap: 11,
              // >=44px tap targets in the chip row (touch); a comfortable list row on desktop.
              minHeight: belowRail ? 44 : undefined,
              padding: belowRail ? "9px 14px" : "9px 10px",
              borderRadius: 9,
              cursor: "pointer",
              marginBottom: belowRail ? 0 : 2,
              fontSize: 13,
              fontWeight: "var(--weight-medium)",
              whiteSpace: "nowrap",
              color: active ? "var(--ink)" : "var(--ink-2)",
              background: active ? "var(--card-2)" : "transparent",
              boxShadow: active ? "inset 2px 0 0 var(--brand)" : "none",
              transition: "background .12s ease, color .12s ease",
              width: belowRail ? "auto" : "100%",
              flex: belowRail ? "none" : undefined,
            }}
          >
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              style={{ flex: "none" }}
              aria-hidden
            >
              <path
                d={s.icon}
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {s.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div
      style={{
        display: belowRail ? "block" : "flex",
        gap: 28,
        padding: phone ? "22px 14px 48px" : "28px 32px 48px",
        alignItems: "flex-start",
      }}
    >
      <style>{LOCAL_CSS}</style>
      {nav}
      <div style={{ flex: 1, minWidth: 0, maxWidth: 820 }}>
        {error && (
          <div
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              background: "var(--error-soft)",
              border:
                "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
              color: "var(--state-error)",
              fontSize: "var(--text-sm)",
            }}
          >
            {error}
          </div>
        )}
        <div key={section} className="naary-set-fade">
          {section === "secrets" && <SecretsSection envs={envs} />}
          {section === "variables" && <VariablesSection envs={envs} />}
          {section === "templates" && <TemplatesSection envs={envs} />}
          {section === "notifications" && (
            <NotificationsSection tenantId={tenantId} envs={envs} />
          )}
          {section === "botprotection" && <TurnstileSection envs={envs} />}
          {section === "experience" && (
            <ExperienceSection tenantId={tenantId} />
          )}
        </div>
      </div>
    </div>
  );
}
