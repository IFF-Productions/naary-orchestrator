// Experience section (redesign) — the Builder / Simple variant cards (radio ring,
// ember active border) wired to the existing per-USER mode preference (useMode:
// localStorage + server `/me/preferences`), plus the real workspace defaults
// (display name + default agent model from TenantSettings). The design's extra
// "workspace default" toggles (dark-by-default, confirm-before-promote, …) don't
// exist in the product, so they are not rendered.
import { useEffect, useState } from "react";
import { Button, TextInput } from "../../../components";
import { api, type TenantSettings, UnauthorizedError } from "../../../lib/api";
import { type Mode, useMode } from "../../../mode";
import { useWorkspace } from "../../../workspace/WorkspaceProvider";
import { ErrorLine, SectionHeader, SectionIntro } from "./shared";

const MODELS = ["", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

const VARIANTS: {
  id: Mode;
  name: string;
  who: string;
  accent: string;
  iconPath: string;
  desc: string;
}[] = [
  {
    id: "builder",
    name: "Builder",
    who: "Power users · full canvas",
    accent: "var(--brand)",
    iconPath: "M4 5h7v6H4zM13 13h7v6h-7zM11 8h4a2 2 0 0 1 2 2v3",
    desc: "Free-form canvas, the full node catalog, environments, expressions and code fields, MCP & API.",
  },
  {
    id: "simple",
    name: "Simple",
    who: "Non-technical · step list",
    accent: "var(--state-info)",
    iconPath: "M4 7h10M4 12h16M4 17h7",
    desc: "Describe it in English and review a linear “when → do → ask” step list. Compiles to the same graph — open it in Builder anytime to grow up.",
  },
];

export function ExperienceSection({ tenantId }: { tenantId: string | null }) {
  const { mode, setMode } = useMode();
  const { refresh: refreshWorkspaces } = useWorkspace();

  const [displayName, setDisplayName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    (async () => {
      try {
        const s = await api.getSettings(tenantId);
        if (!live) return;
        setDisplayName(s.displayName ?? "");
        setDefaultModel(s.defaultModel ?? "");
        setLoaded(true);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Sign in to view workspace settings."
              : "Could not load workspace settings.",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, [tenantId]);

  async function save() {
    if (!tenantId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const patch: TenantSettings = {
        displayName: displayName.trim() || null,
        defaultModel: defaultModel || null,
      };
      const saved = await api.saveSettings(tenantId, patch);
      setDisplayName(saved.displayName ?? "");
      setDefaultModel(saved.defaultModel ?? "");
      // The display name IS the workspace name — refresh the switcher so a rename
      // shows immediately (no page reload).
      await refreshWorkspaces().catch(() => undefined);
      setStatus("Saved.");
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save settings."
          : "Could not save settings.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Experience" />
      <SectionIntro>
        Choose how you author workflows. Both variants share the same engine,
        runs, and approvals — Simple hides design-time complexity, never
        run-time truth. This is your personal preference; it doesn't change the
        workspace for other members.
      </SectionIntro>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 14,
        }}
      >
        {VARIANTS.map((v) => {
          const on = mode === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(v.id)}
              style={{
                all: "unset",
                boxSizing: "border-box",
                border: `1px solid ${on ? "var(--brand)" : "var(--line-mid)"}`,
                background: "var(--panel)",
                borderRadius: 14,
                padding: "16px 18px",
                cursor: "pointer",
                transition: "border-color .15s",
                boxShadow: on ? "0 0 0 1px rgba(242,98,46,.2)" : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 11,
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    flex: "none",
                    borderRadius: 9,
                    border: `1px solid ${v.accent}`,
                    color: v.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg
                    width={17}
                    height={17}
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d={v.iconPath}
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: "var(--weight-bold)",
                      color: "var(--ink)",
                    }}
                  >
                    {v.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-faint)" }}>
                    {v.who}
                  </div>
                </div>
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    flex: "none",
                    border: `1px solid ${on ? "var(--brand)" : "var(--line-2)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {on && (
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: "var(--brand)",
                      }}
                    />
                  )}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  lineHeight: 1.55,
                }}
              >
                {v.desc}
              </div>
            </button>
          );
        })}
      </div>

      {/* Workspace defaults — the REAL workspace-level settings (name + default model). */}
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--panel)",
          borderRadius: 14,
          padding: "18px 20px",
          marginTop: 16,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            marginBottom: 4,
          }}
        >
          Workspace defaults
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--ink-3)",
            marginBottom: 14,
          }}
        >
          Shared by everyone in this workspace.
        </div>

        {error && <ErrorLine>{error}</ErrorLine>}

        <div style={{ display: "grid", gap: 14, maxWidth: 460 }}>
          <label style={{ display: "block" }}>
            <span className="field-label">Workspace display name</span>
            <TextInput
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Acme Inc."
              disabled={!loaded}
            />
          </label>
          <label style={{ display: "block" }}>
            <span className="field-label">Default agent model</span>
            <select
              className="input"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              disabled={!loaded}
            >
              {MODELS.map((m) => (
                <option key={m || "none"} value={m}>
                  {m || "— none —"}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button
              variant="primary"
              loading={busy}
              disabled={!loaded}
              onClick={() => void save()}
            >
              Save settings
            </Button>
            {status && (
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--state-done)",
                }}
              >
                {status}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
