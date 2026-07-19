import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components";
import { api, type GraphSummary, UnauthorizedError } from "../../lib/api";

/** Simple-mode home: the tenant's automations (which are just saved graphs). */
export function Automations() {
  const navigate = useNavigate();
  const [items, setItems] = useState<GraphSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .listGraphs()
      .then(setItems)
      .catch((e) => {
        setItems([]);
        setErr(
          e instanceof UnauthorizedError
            ? "Sign in to see your automations."
            : "Could not reach the server.",
        );
      });
  }, []);

  return (
    <div
      style={{
        padding: "22px 28px 40px",
        maxWidth: 720,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Automations
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            Describe what you want, and let the AI build it.
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => navigate("/app/automations/new")}
        >
          New automation
        </Button>
      </div>

      {err && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      {items && items.length === 0 && (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            background: "var(--card)",
            border: "1px dashed var(--line-2)",
            borderRadius: "var(--radius-lg)",
            color: "var(--ink-3)",
            fontSize: "var(--text-body)",
          }}
        >
          No automations yet.
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => navigate("/app/automations/new")}
            >
              Create your first
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(items ?? []).map((it) => (
          <button
            key={it.workflowKey}
            type="button"
            onClick={() =>
              navigate(`/app/automations/${encodeURIComponent(it.workflowKey)}`)
            }
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              boxSizing: "border-box",
              width: "100%",
              padding: "14px 16px",
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-card)",
              transition: "background .12s ease, border-color .12s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--card-2)";
              e.currentTarget.style.borderColor = "var(--line-2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--card)";
              e.currentTarget.style.borderColor = "var(--line)";
            }}
          >
            <span
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              {it.name}
            </span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              v{it.version} · edit →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
