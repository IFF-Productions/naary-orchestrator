// Poll / schedule / chat / form trigger config sections of the node inspector (extracted verbatim from CanvasPage).
import type { FormBrandingConfig } from "@naary/dsl";
import type { ConfigSectionCtx } from "./ConfigPanel";
import { Button } from "../../components";
import { api } from "../../lib/api";
import {
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  Labeled,
} from "./fields";
import { FormBrandingSection } from "./FormBrandingSection";
import { TemplateSelect } from "./TemplateSelect";

export function renderTriggerSections(c: ConfigSectionCtx) {
  const {
    node,
    kind,
    config,
    str,
    num,
    obj,
    exprText,
    onChange,
    upstreamIds,
    edges,
    nodeKinds,
    connections,
    pins,
  } = c;
  return (
    <>
      {kind === "pollTrigger" && (
        <>
          <Labeled label="URL to poll">
            {exprText("url", {
              placeholder: "https://api.example.com/resource",
            })}
          </Labeled>
          <Labeled label="Check every (seconds)">
            <input
              type="number"
              value={num("intervalSeconds") ?? 300}
              onChange={(e) =>
                onChange({ intervalSeconds: Number(e.target.value) })
              }
              style={inputStyle}
              placeholder="300"
            />
          </Labeled>
          <Labeled label="Change key (JSON path, optional)">
            <input
              value={str("changeKey")}
              onChange={(e) => onChange({ changeKey: e.target.value })}
              style={inputStyle}
              placeholder="items.0.id (blank = whole response)"
            />
          </Labeled>
        </>
      )}

      {kind === "kafkaTrigger" && (
        <>
          <Labeled label="Kafka connection">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
              lineHeight: 1.5,
            }}
          >
            Starts ONE run per message. Messages are drained on the interval
            below, so a message waits up to that long before its run starts. A
            redelivered message does not start a second run — the run is
            identified by the message&apos;s topic, partition and offset.
          </div>

          <Labeled label="Topic">
            <input
              value={str("topic")}
              onChange={(e) => onChange({ topic: e.target.value })}
              style={inputStyle}
              placeholder="orders.created"
            />
          </Labeled>

          <Labeled label="Consumer group">
            <input
              value={str("groupId")}
              onChange={(e) => onChange({ groupId: e.target.value })}
              style={inputStyle}
              placeholder="naary-orders"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
              lineHeight: 1.5,
            }}
          >
            The broker remembers this group&apos;s position, which is what lets
            the workflow resume where it left off. Give each workflow its own
            group — two workflows sharing one would split the topic between
            them, and each would see only some of the messages.
          </div>

          <Labeled label="Check every (seconds)">
            <input
              type="number"
              value={num("intervalSeconds") ?? 30}
              onChange={(e) =>
                onChange({ intervalSeconds: Number(e.target.value) })
              }
              style={inputStyle}
              placeholder="30"
            />
          </Labeled>

          <Labeled label="Messages per check (max)">
            <input
              type="number"
              value={num("maxMessages") ?? 50}
              onChange={(e) =>
                onChange({ maxMessages: Number(e.target.value) })
              }
              style={inputStyle}
              placeholder="50"
            />
          </Labeled>

          <Labeled label="Start from the beginning of the topic">
            <input
              type="checkbox"
              checked={config.fromBeginning === true}
              onChange={(e) => onChange({ fromBeginning: e.target.checked })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
              lineHeight: 1.5,
            }}
          >
            Only applies the first time this consumer group runs — once it has a
            saved position, that position wins. Turning it on later does not
            replay the topic.
          </div>
        </>
      )}

      {kind === "scheduleTrigger" && (
        <>
          <Labeled label="Cron expression">
            <input
              value={str("cron")}
              onChange={(e) => onChange({ cron: e.target.value })}
              style={inputStyle}
              placeholder="0 9 * * 1-5"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Standard cron (min hour day month weekday). The schedule is created
            server-side when you save. Examples: <code>*/15 * * * *</code>{" "}
            (every 15 min), <code>0 9 * * 1-5</code> (weekdays 9am),{" "}
            <code>0 0 1 * *</code> (1st of the month).
          </div>
        </>
      )}

      {kind === "chatTrigger" && (
        <>
          <Labeled label="Chat title (optional)">
            <input
              value={str("title")}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
              placeholder="Ask us anything"
            />
          </Labeled>
          <Labeled label="Description (optional)">
            <input
              value={str("description")}
              onChange={(e) => onChange({ description: e.target.value })}
              style={inputStyle}
              placeholder="We're here to help."
            />
          </Labeled>
          <Labeled label="Input placeholder (optional)">
            <input
              value={str("placeholder")}
              onChange={(e) => onChange({ placeholder: e.target.value })}
              style={inputStyle}
              placeholder="Type a message…"
            />
          </Labeled>
          <Labeled label="Greeting (optional)">
            <input
              value={str("greeting")}
              onChange={(e) => onChange({ greeting: e.target.value })}
              style={inputStyle}
              placeholder="Hi! How can I help?"
            />
          </Labeled>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(config.durableSession)}
              onChange={(e) => onChange({ durableSession: e.target.checked })}
            />
            Durable session (remember the conversation across messages)
          </label>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            The message + session id arrive as <code>{node.id}</code>. With
            durable session on, a long-lived per-session workflow holds the
            conversation in Temporal; off, each message is threaded with the
            saved history.
          </div>
        </>
      )}

      {kind === "mcpServerTrigger" && (
        <>
          <Labeled label="Tool name (optional)">
            <input
              value={str("toolName")}
              onChange={(e) => onChange({ toolName: e.target.value })}
              style={inputStyle}
              placeholder="run_refund"
            />
          </Labeled>
          <Labeled label="Description (optional)">
            <input
              value={str("description")}
              onChange={(e) => onChange({ description: e.target.value })}
              style={inputStyle}
              placeholder="Process a customer refund."
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            This workflow is hosted as a tool on naary's MCP server. An external
            AI agent (Claude Desktop, Cursor, an SDK agent) that connects sees
            it as <code>{str("toolName") || "run_<workflowKey>"}</code> and
            invoking it starts a durable run — the tool-call arguments arrive as{" "}
            <code>{node.id}</code>. Blank tool name ⇒ a name is derived from the
            workflow key. The workflow must be Active to be invocable.
          </div>
        </>
      )}

      {kind === "formTrigger" &&
        (() => {
          const fields = (
            Array.isArray(config.fields) ? config.fields : []
          ) as Array<{
            key?: string;
            label?: string;
            type?: string;
            required?: boolean;
            options?: string[];
          }>;
          const setFields = (next: unknown[]) => onChange({ fields: next });
          const patchField = (i: number, patch: Record<string, unknown>) =>
            setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
          return (
            <>
              <Labeled label="Form title (optional)">
                <input
                  value={str("title")}
                  onChange={(e) => onChange({ title: e.target.value })}
                  style={inputStyle}
                  placeholder="Contact us"
                />
              </Labeled>
              <Labeled label="Description (optional)">
                <input
                  value={str("description")}
                  onChange={(e) => onChange({ description: e.target.value })}
                  style={inputStyle}
                  placeholder="We'll get back to you shortly."
                />
              </Labeled>
              <Labeled label="Submit button label (optional)">
                <input
                  value={str("submitLabel")}
                  onChange={(e) => onChange({ submitLabel: e.target.value })}
                  style={inputStyle}
                  placeholder="Submit"
                />
              </Labeled>

              {/* Hosted-page presentation. `obj("branding")` so an unset branding block reads as {}
                  and each patch merges rather than replacing the other keys. */}
              <FormBrandingSection
                branding={(obj("branding") ?? {}) as FormBrandingConfig}
                onChange={(patch) =>
                  onChange({
                    branding: { ...(obj("branding") ?? {}), ...patch },
                  })
                }
              />

              <Labeled label="Form template (optional)">
                <TemplateSelect
                  kind="form"
                  value={str("templateId")}
                  onChange={(id) => onChange({ templateId: id })}
                />
              </Labeled>
              {str("templateId") && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: -6,
                  }}
                >
                  The template's fields drive this form — the inline fields
                  below are ignored while a template is selected (they're the
                  fallback if it's deleted). Manage templates in Settings ›
                  Content templates.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                      fontWeight: "var(--weight-semibold)",
                    }}
                  >
                    Fields
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="plus"
                    onClick={() =>
                      setFields([
                        ...fields,
                        { key: "", label: "", type: "text" },
                      ])
                    }
                  >
                    Add field
                  </Button>
                </div>
                {fields.length === 0 && (
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    No fields yet. Each submitted value becomes the trigger
                    output, keyed by the field's key.
                  </div>
                )}
                {fields.map((f, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: fields are positional
                    key={i}
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: "var(--radius-md)",
                      padding: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={f.key ?? ""}
                        onChange={(e) => patchField(i, { key: e.target.value })}
                        style={inputStyle}
                        placeholder="key (e.g. email)"
                      />
                      <input
                        value={f.label ?? ""}
                        onChange={(e) =>
                          patchField(i, { label: e.target.value })
                        }
                        style={inputStyle}
                        placeholder="Label"
                      />
                    </div>
                    <div
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <select
                        value={f.type ?? "text"}
                        onChange={(e) =>
                          patchField(i, { type: e.target.value })
                        }
                        style={inputStyle}
                      >
                        {["text", "textarea", "number", "email", "select"].map(
                          (t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ),
                        )}
                      </select>
                      <label
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          fontSize: "var(--text-sm)",
                          color: "var(--ink-2)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(f.required)}
                          onChange={(e) =>
                            patchField(i, {
                              required: e.target.checked || undefined,
                            })
                          }
                        />
                        Required
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="trash"
                        iconOnly
                        title="Remove field"
                        onClick={() =>
                          setFields(fields.filter((_, j) => j !== i))
                        }
                      />
                    </div>
                    {f.type === "select" && (
                      <input
                        value={(f.options ?? []).join(", ")}
                        onChange={(e) =>
                          patchField(i, {
                            options: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        style={inputStyle}
                        placeholder="option1, option2, option3"
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          );
        })()}
    </>
  );
}
