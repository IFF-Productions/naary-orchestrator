// Trigger endpoint registration forms (webhook, form, chat) for the Integrations screen.
import { useEffect, useState } from "react";
import { Button } from "../../../components";
import {
  api,
  type GraphSummary,
  type RegisteredChat,
  type RegisteredForm,
  type RegisteredWebhook,
} from "../../../lib/api";
import {
  chatUrl,
  EmbedSnippet,
  fieldLabel,
  fieldStyle,
  formUrl,
  UrlCopy,
} from "./shared";
import { WorkflowPicker } from "./WorkflowPicker";

/**
 * The tenant's saved workflows in the ACTIVE environment, for the registration pickers.
 * All three endpoint kinds need the same list, and `loading` keeps the pickers from claiming
 * "no workflows yet" during the first fetch.
 */
function useWorkflowList(): { workflows: GraphSummary[]; loading: boolean } {
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    api
      .listGraphs()
      .then((gs) => {
        if (alive) setWorkflows(gs);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { workflows, loading };
}

/** Register a hosted chat for a workflow whose entry node is a chatTrigger. Mirrors FormForm; on
 *  success it surfaces the shareable /c/ URL. 400s (with a hint) if the tenant has no budget cap. */
export function ChatForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredChat | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { workflows, loading } = useWorkflowList();

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createChat(tenant, {
        workflowId: workflowId.trim(),
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Set a monthly budget for this tenant first — a public chat needs a spend cap (Billing)."
          : "Could not register the chat.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>Workflow to host as a chat</span>
        <WorkflowPicker
          workflows={workflows}
          loading={loading}
          value={workflowId}
          onChange={setWorkflowId}
          entryType="chatTrigger"
          requires="a Chat trigger"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !workflowId.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Registering…" : "Register"}
        </Button>
        {msg && (
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 8,
            }}
          >
            Your chat is live. Share this public URL — anyone with it can chat
            (no sign-in):
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                background: "var(--card)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-sm)",
                padding: "7px 9px",
                wordBreak: "break-all",
              }}
            >
              {chatUrl(registered.chatId)}
            </span>
            <UrlCopy url={chatUrl(registered.chatId)} />
          </div>
          <EmbedSnippet id={registered.chatId} kind="chat" />
        </div>
      )}
    </>
  );
}

/** Register a hosted form for a workflow whose entry node is a formTrigger. On success it surfaces
 *  the shareable public URL. Registration 400s if the tenant has no monthly budget cap — surfaced
 *  as a clear hint (the anonymous endpoint requires a spend backstop). */
export function FormForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredForm | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { workflows, loading } = useWorkflowList();

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createForm(tenant, {
        workflowId: workflowId.trim(),
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Set a monthly budget for this tenant first — a public form needs a spend cap (Billing)."
          : "Could not register the form.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>Workflow to host as a form</span>
        <WorkflowPicker
          workflows={workflows}
          loading={loading}
          value={workflowId}
          onChange={setWorkflowId}
          entryType="formTrigger"
          requires="a Form trigger"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !workflowId.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Registering…" : "Register"}
        </Button>
        {msg && (
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 8,
            }}
          >
            Your form is live. Share this public URL — anyone with it can submit
            (no sign-in):
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                background: "var(--card)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-sm)",
                padding: "7px 9px",
                wordBreak: "break-all",
              }}
            >
              {formUrl(registered.formId)}
            </span>
            <UrlCopy url={formUrl(registered.formId)} />
          </div>
          <EmbedSnippet id={registered.formId} kind="form" />
        </div>
      )}
    </>
  );
}

export function WebhookForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [provider, setProvider] = useState("github");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredWebhook | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Typing a key by hand was the #1 registration footgun ("No graph seeded for workflowKey
  // '…'" 404s on a typo / an unsaved key) — so the workflow is CHOSEN from real, saved
  // graphs, never typed. No entryType filter here: ANY workflow can be webhook-triggered.
  const { workflows, loading } = useWorkflowList();

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createWebhook(tenant, {
        workflowId: workflowId.trim(),
        provider,
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch {
      setMsg("Could not register the webhook.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Workflow to trigger</span>
        <WorkflowPicker
          workflows={workflows}
          loading={loading}
          value={workflowId}
          onChange={setWorkflowId}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
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
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !workflowId.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Registering…" : "Register"}
        </Button>
        {msg && (
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <WebhookHowTo
          registered={registered}
          copied={copied}
          setCopied={setCopied}
        />
      )}
    </>
  );
}

/** Shown once after registering: the secret + a ready-to-run signed curl. The
 *  webhook is authenticated by an HMAC-SHA256 signature over the RAW body. */
function WebhookHowTo({
  registered,
  copied,
  setCopied,
}: {
  registered: RegisteredWebhook;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const curl = [
    "# 1. your API host + a JSON body (any shape — it becomes the trigger output)",
    "API=<YOUR_API_URL>",
    `BODY='{"hello":"world"}'`,
    "",
    "# 2. sign the RAW body with the signing secret (HMAC-SHA256, hex)",
    `SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "${registered.signingSecret}" -r | cut -d' ' -f1)"`,
    "",
    "# 3. POST it",
    `curl -X POST "$API${registered.ingressPath}" \\`,
    '  -H "content-type: application/json" \\',
    '  -H "X-Hub-Signature-256: $SIG" \\',
    '  -H "x-delivery-id: $(uuidgen)" \\',
    '  --data-binary "$BODY"',
  ].join("\n");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is still visible to copy manually */
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: "var(--radius-md)",
        background: "var(--brand-soft)",
        border: "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 8,
        }}
      >
        Save this signing secret now — it is shown <strong>only once</strong>.
        The webhook is authenticated by an{" "}
        <strong>HMAC-SHA256 signature over the raw body</strong> (no bearer
        token).
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 4,
        }}
      >
        POST {registered.ingressPath}
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-semibold)",
          wordBreak: "break-all",
          color: "var(--brand)",
        }}
      >
        {registered.signingSecret}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "12px 0 6px",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-2)",
          }}
        >
          Trigger it (copy &amp; run)
        </div>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied ✓" : "Copy curl"}
        </Button>
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 10,
          borderRadius: "var(--radius-sm)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          fontSize: "var(--text-2xs)",
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre",
          color: "var(--ink)",
        }}
      >
        {curl}
      </pre>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          marginTop: 6,
        }}
      >
        Replace <code>&lt;YOUR_API_URL&gt;</code> with your API host. Sign the
        exact bytes you send. A repeat with the same <code>x-delivery-id</code>{" "}
        is ignored.
      </div>
    </div>
  );
}
