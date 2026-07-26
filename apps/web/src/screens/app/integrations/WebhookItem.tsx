// Registered webhook row (view + inline edit + rotate secret) for the Integrations screen.
import { useEffect, useState } from "react";
import { Icon, StatusPill, useConfirm } from "../../../components";
import { api, type GraphSummary, type WebhookRow } from "../../../lib/api";
import { EnvChip, fieldLabel, fieldStyle, UrlCopy } from "./shared";

/**
 * One registered webhook row — view + INLINE EDIT. View shows the URL + "POST · provider ·
 * workflow"; Edit swaps in a workflow picker + provider select (Save updates in place, keeping
 * the id/URL/secret). Rotate mints a new signing secret (shown once). Delete removes it.
 */
export function WebhookItem({
  w,
  env,
  tenant,
  isLast,
  webhookUrl,
  onChanged,
  onError,
}: {
  w: WebhookRow;
  /** Active environment slug — the endpoint's real env binding (lists are env-scoped). */
  env: string | null;
  tenant: string | null;
  isLast: boolean;
  webhookUrl: (id: string) => string;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [wf, setWf] = useState(w.workflowId);
  const [provider, setProvider] = useState(w.provider);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);

  // Load the saved workflows for the picker only when the user starts editing.
  useEffect(() => {
    if (!editing || workflows.length > 0) return;
    let alive = true;
    api
      .listGraphs()
      .then((gs) => alive && setWorkflows(gs))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [editing, workflows.length]);

  function startEdit() {
    setWf(w.workflowId);
    setProvider(w.provider);
    setNewSecret(null);
    setEditing(true);
  }

  async function save() {
    if (!tenant) return;
    setSaving(true);
    try {
      await api.updateWebhook(tenant, w.id, { workflowId: wf, provider });
      setEditing(false);
      await onChanged();
    } catch {
      onError("Could not update the webhook.");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!tenant) return;
    const ok = await confirm({
      title: "Rotate the signing secret?",
      body: "Any provider still using the old secret will fail until you reconfigure it with the new one.",
      confirmLabel: "Rotate secret",
      danger: true,
    });
    if (!ok) return;
    setRotating(true);
    try {
      const { signingSecret } = await api.rotateWebhookSecret(tenant, w.id);
      setNewSecret(signingSecret);
    } catch {
      onError("Could not rotate the signing secret.");
    } finally {
      setRotating(false);
    }
  }

  async function remove() {
    if (!tenant || deleting) return;
    const ok = await confirm({
      title: "Delete this webhook endpoint?",
      body: "Calls to its URL will stop working immediately.",
      confirmLabel: "Delete webhook",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    void api
      .deleteWebhook(tenant, w.id)
      .then(() => onChanged())
      .catch(() => onError("Could not delete the webhook."))
      .finally(() => setDeleting(false));
  }

  return (
    <div
      style={{
        padding: "14px 16px",
        borderBottom: isLast ? undefined : "1px solid var(--line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-md)",
            background:
              "color-mix(in srgb, var(--node-trigger) 15%, transparent)",
            color: "var(--node-trigger)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
          }}
        >
          <Icon name="bolt" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={webhookUrl(w.id)}
          >
            {webhookUrl(w.id)}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 3,
            }}
          >
            <EnvChip slug={env} />
            POST · {w.provider} · {w.workflowId}
            {w.deliveries7d !== undefined &&
              ` · ${w.deliveries7d} deliver${
                w.deliveries7d === 1 ? "y" : "ies"
              } (7d)`}
          </div>
        </div>
        {!editing && <UrlCopy url={webhookUrl(w.id)} />}
        {!editing && <StatusPill state="done" label="Active" />}
        {!editing ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              title="Edit endpoint"
              onClick={startEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={deleting}
              title="Delete endpoint"
              onClick={remove}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={saving || !wf.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {editing && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            animation: "naaryFadeUp .2s ease",
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
          }}
        >
          <div style={{ flex: "1 1 220px", minWidth: 180 }}>
            <span style={fieldLabel}>Workflow to trigger</span>
            <select
              style={fieldStyle}
              value={wf}
              onChange={(e) => setWf(e.target.value)}
            >
              {/* Keep the current value selectable even if listGraphs hasn't loaded / it was deleted. */}
              {!workflows.some((g) => g.workflowKey === wf) && (
                <option value={wf}>{wf}</option>
              )}
              {workflows.map((g) => (
                <option key={g.workflowKey} value={g.workflowKey}>
                  {g.name} ({g.workflowKey})
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: "0 1 160px", minWidth: 140 }}>
            <span style={fieldLabel}>Provider</span>
            <select
              style={fieldStyle}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="github">github</option>
              <option value="atlassian">atlassian</option>
              <option value="generic">generic</option>
            </select>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={rotating}
            title="Mint a new signing secret"
            onClick={() => void rotate()}
          >
            {rotating ? "Rotating…" : "Rotate secret"}
          </button>
        </div>
      )}

      {newSecret && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 30%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 6,
            }}
          >
            New signing secret — copy it now, it won't be shown again.
            Reconfigure the provider with it.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-xs)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {newSecret}
            </code>
            <UrlCopy url={newSecret} />
          </div>
        </div>
      )}
    </div>
  );
}
