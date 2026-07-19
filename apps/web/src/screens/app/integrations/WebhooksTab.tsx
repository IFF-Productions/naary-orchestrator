// Webhooks tab — inbound trigger endpoints: signed webhooks, hosted forms, hosted chats.
import { useState } from "react";
import {
  Button,
  Dialog,
  Icon,
  type IconName,
  StatusPill,
} from "../../../components";
import {
  api,
  type ChatRow,
  type FormRow,
  type WebhookRow,
} from "../../../lib/api";
import {
  cardShell,
  chatUrl,
  EnvChip,
  formUrl,
  IconTile,
  introStyle,
  monoLabel,
  UrlCopy,
  webhookUrl,
} from "./shared";
import { ChatForm, FormForm, WebhookForm } from "./trigger-forms";
import { WebhookItem } from "./WebhookItem";

/** One hosted public endpoint row (form or chat) — URL + copy + delete. */
function PublicEndpointRow({
  icon,
  color,
  url,
  meta,
  env,
  isLast,
  deleting,
  onDelete,
}: {
  icon: IconName;
  color: string;
  url: string;
  meta: string;
  env: string | null;
  isLast: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderBottom: isLast ? undefined : "1px solid var(--line)",
      }}
    >
      <IconTile name={icon} color={color} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mono"
          style={{
            display: "block",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textDecoration: "none",
          }}
          title={url}
        >
          {url}
        </a>
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
          {meta}
        </div>
      </div>
      <UrlCopy url={url} />
      <StatusPill state="done" label="Active" />
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled={deleting}
        onClick={onDelete}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}

export function WebhooksTab({
  tenant,
  env,
  webhooks,
  forms,
  chats,
  onChanged,
  onError,
}: {
  tenant: string | null;
  env: string | null;
  webhooks: WebhookRow[];
  forms: FormRow[];
  chats: ChatRow[];
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [dialog, setDialog] = useState<"webhook" | "form" | "chat" | null>(
    null,
  );
  const [deletingForm, setDeletingForm] = useState<string | null>(null);
  const [deletingChat, setDeletingChat] = useState<string | null>(null);

  function removeForm(id: string) {
    if (!tenant || deletingForm) return;
    if (!window.confirm("Delete this form? Its public URL will stop working."))
      return;
    setDeletingForm(id);
    void api
      .deleteForm(tenant, id)
      .then(() => onChanged())
      .catch(() => onError("Could not delete the form."))
      .finally(() => setDeletingForm(null));
  }

  function removeChat(id: string) {
    if (!tenant || deletingChat) return;
    if (!window.confirm("Delete this chat? Its public URL will stop working."))
      return;
    setDeletingChat(id);
    void api
      .deleteChat(tenant, id)
      .then(() => onChanged())
      .catch(() => onError("Could not delete the chat."))
      .finally(() => setDeletingChat(null));
  }

  return (
    <div>
      {/* ---- Signed webhooks ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Inbound webhooks
          </div>
          <div style={{ ...introStyle, marginTop: 3 }}>
            HMAC-signed endpoints that trigger workflows — each fires runs in
            the environment it was registered in.
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => setDialog("webhook")}
        >
          New webhook
        </Button>
      </div>
      <div style={{ ...cardShell, marginBottom: 28 }}>
        {webhooks.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No webhooks in this environment — register one to trigger a workflow
            from an inbound HTTP call.
          </div>
        )}
        {webhooks.map((w, i) => (
          <WebhookItem
            key={w.id}
            w={w}
            env={env}
            tenant={tenant}
            isLast={i >= webhooks.length - 1}
            webhookUrl={webhookUrl}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </div>

      {/* ---- Hosted forms ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span style={monoLabel}>Hosted forms (public)</span>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => setDialog("form")}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="plus" size={12} strokeWidth={2} />
          New form
        </button>
      </div>
      <div style={{ ...cardShell, marginBottom: 28 }}>
        {forms.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No hosted forms in this environment — register one to collect
            submissions that start a workflow.
          </div>
        )}
        {forms.map((f, i) => (
          <PublicEndpointRow
            key={f.id}
            icon="edit"
            color="var(--node-trigger)"
            url={formUrl(f.id)}
            meta={`public form · ${f.workflowId}`}
            env={env}
            isLast={i >= forms.length - 1}
            deleting={deletingForm === f.id}
            onDelete={() => removeForm(f.id)}
          />
        ))}
      </div>

      {/* ---- Hosted chats ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span style={monoLabel}>Hosted chats (public)</span>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => setDialog("chat")}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="plus" size={12} strokeWidth={2} />
          New chat
        </button>
      </div>
      <div style={cardShell}>
        {chats.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No hosted chats in this environment — register one to serve a public
            chat widget backed by a workflow.
          </div>
        )}
        {chats.map((c, i) => (
          <PublicEndpointRow
            key={c.id}
            icon="agent"
            color="var(--node-agent)"
            url={chatUrl(c.id)}
            meta={`public chat · ${c.workflowId}`}
            env={env}
            isLast={i >= chats.length - 1}
            deleting={deletingChat === c.id}
            onDelete={() => removeChat(c.id)}
          />
        ))}
      </div>

      {/* ---- Create dialogs (the existing registration forms, unchanged) ---- */}
      {tenant && (
        <Dialog
          open={dialog !== null}
          onClose={() => setDialog(null)}
          title={
            dialog === "webhook"
              ? "Register a webhook"
              : dialog === "form"
                ? "Register a form"
                : "Register a chat"
          }
        >
          {dialog === "webhook" && (
            <WebhookForm tenant={tenant} onChanged={onChanged} />
          )}
          {dialog === "form" && (
            <FormForm tenant={tenant} onChanged={onChanged} />
          )}
          {dialog === "chat" && (
            <ChatForm tenant={tenant} onChanged={onChanged} />
          )}
        </Dialog>
      )}
    </div>
  );
}
