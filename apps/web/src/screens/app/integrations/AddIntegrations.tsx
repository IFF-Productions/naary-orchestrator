// "Add integration" collapsed-create-forms stack for the Integrations screen.
import { useState } from "react";
import { Icon } from "../../../components";
import {
  ConnectForm,
  DatabaseForm,
  GithubAppForm,
  SigningForm,
  SmtpForm,
} from "./connection-forms";
import { ChatForm, FormForm, WebhookForm } from "./trigger-forms";

/* ===== Real create actions: connect a server + register a webhook ===== */

/** A card that collapses to a single clickable header row (title + subtitle + accent bar) and
 *  expands to reveal its body. Declutters stacks of forms into a tidy, scannable list. */
function Collapsible({
  title,
  subtitle,
  accent,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  accent: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 4,
            height: 26,
            borderRadius: "var(--radius-full)",
            background: accent,
            flex: "none",
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                display: "block",
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 2,
              }}
            >
              {subtitle}
            </span>
          )}
        </span>
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={16}
          style={{ color: "var(--ink-3)", flex: "none" }}
        />
      </button>
      {open && (
        <div
          style={{
            padding: "6px 16px 16px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function AddIntegrations({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginBottom: 24,
      }}
    >
      <Collapsible
        title="Connect MCP server"
        subtitle="Call remote tools from an mcpTool node"
        accent="var(--node-mcp)"
      >
        <ConnectForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Connect GitHub (App)"
        subtitle="Install the GitHub App to authorize repos — no personal token"
        accent="var(--brand)"
      >
        <GithubAppForm tenant={tenant} />
      </Collapsible>
      <Collapsible
        title="Connect a database"
        subtitle="For the SQL Query / SQL Exec nodes"
        accent="var(--node-sql, var(--brand))"
      >
        <DatabaseForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Add a signing key"
        subtitle="For the hmac / jwt / totp nodes"
        accent="var(--node-hash, var(--brand))"
      >
        <SigningForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Configure SMTP (email)"
        subtitle="For the sendEmail node"
        accent="var(--node-agent, var(--brand))"
      >
        <SmtpForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Register a webhook"
        subtitle="Trigger a workflow from an inbound HTTP call"
        accent="var(--node-trigger)"
      >
        <WebhookForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Register a form"
        subtitle="Collect submissions on a public page that start a workflow"
        accent="var(--node-trigger)"
      >
        <FormForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Register a chat"
        subtitle="Serve a public chat widget backed by a workflow"
        accent="var(--node-agent)"
      >
        <ChatForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
    </div>
  );
}
