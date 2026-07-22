// Save-only BYOK credential card for a code-agent CLI whose binary isn't verified in this deployment
// yet (cursor / copilot). Unlike the Claude Code card there's NO "Run test" — the live check needs
// the CLI installed in the worker/sandbox image (a deploy step). This just stores the dedicated
// credential (encrypted, never echoed) so the driver can use it once the CLI lands.
import { useState } from "react";
import { Button, StatusPill } from "../../../components";
import { api } from "../../../lib/api";

export function CodeAgentCredentialCard({
  tenant,
  provider,
  label,
  badge,
  placeholder,
  hint,
  hasKey,
  keyValid,
  onSaved,
}: {
  tenant: string | null;
  /** The dedicated credential slot — "cursor" | "copilot". */
  provider: string;
  label: string;
  /** One-glyph avatar. */
  badge: string;
  placeholder: string;
  hint: React.ReactNode;
  hasKey: boolean;
  keyValid: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function saveKey() {
    if (!tenant || !token.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await api.saveCredential(tenant, provider, token.trim());
      setToken("");
      setOpen(false);
      onSaved();
    } catch {
      setErr("Token rejected — check the value and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: 16,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--node-agent)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "var(--weight-bold)",
            flex: "none",
          }}
        >
          {badge}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {label}
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            {hint}
          </div>
        </div>
        {keyValid ? (
          <StatusPill state="done" label="Key set" />
        ) : hasKey ? (
          <StatusPill state="error" label="Key invalid" />
        ) : (
          <StatusPill state="idle" label="No key" />
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, animation: "naaryFadeUp .2s ease" }}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={placeholder}
            autoComplete="new-password"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
            }}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 6,
            }}
          >
            Stored encrypted; never echoed back. The {label} CLI must be
            installed on the worker for the node to run.
          </div>
          {err && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--state-error)",
                marginTop: 6,
              }}
            >
              {err}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button
              variant="primary"
              loading={saving}
              disabled={saving || !token.trim()}
              onClick={() => void saveKey()}
            >
              {saving ? "Saving…" : "Save credential"}
            </Button>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setOpen(false);
                setToken("");
                setErr(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Button
          variant={hasKey ? "secondary" : "primary"}
          icon="key"
          disabled={!tenant}
          onClick={() => setOpen((v) => !v)}
        >
          {hasKey ? "Update credential" : "Set credential"}
        </Button>
      </div>
    </div>
  );
}
