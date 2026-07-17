// sendEmail / rss / sub-workflow / forEach / wait / stop / respond / code / approval config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import {
  type BindingRow,
  BindingsEditor,
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  JsonField,
  Labeled,
  textareaStyle,
} from "./fields";
import { RowHead } from "./PinSection";

export function renderControlSections(c: ConfigSectionCtx) {
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
      {kind === "sendEmail" && (
        <>
          <Labeled label="SMTP connection id">
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
            }}
          >
            An <code>smtp</code> connection — its URI (with credentials) is read
            server-side, never stored in the graph. Output is{" "}
            <code>{node.id}.messageId</code>.
          </div>
          <Labeled label="From (blank = SMTP user)">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="noreply@example.com"
            />
          </Labeled>
          <Labeled label="To">
            {exprText("to", { placeholder: "user@example.com" })}
          </Labeled>
          <Labeled label="Subject">
            {exprText("subject", { placeholder: "Your workflow finished" })}
          </Labeled>
          <Labeled label="Body (text)">
            {exprText("text", {
              multiline: true,
              placeholder: "Plain-text body…",
            })}
          </Labeled>
          <BindingsEditor
            bindings={
              obj("fieldBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ fieldBindings: v })}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Bind <code>to</code> / <code>subject</code> / <code>text</code> /{" "}
            <code>html</code> from upstream outputs to override the static
            values.
          </div>
        </>
      )}

      {kind === "rssRead" && (
        <>
          <Labeled label="Feed URL (https)">
            {exprText("url", { placeholder: "https://example.com/feed.xml" })}
          </Labeled>
          <BindingsEditor
            bindings={
              config.urlBinding
                ? { url: config.urlBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ urlBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Fetches + parses the RSS/Atom feed (egress-guarded). Output is{" "}
            <code>{node.id}.items</code> — an array you can
            filter/sort/aggregate.
          </div>
        </>
      )}

      {kind === "executeSubWorkflow" && (
        <>
          <Labeled label="Sub-workflow key">
            <input
              value={str("workflowKey")}
              onChange={(e) => onChange({ workflowKey: e.target.value })}
              style={inputStyle}
              placeholder="my-saved-workflow"
            />
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Runs that saved graph's latest version as a child run (its own row
            in Runs). Read the result later as <code>{node.id}.status</code> /{" "}
            <code>{node.id}.output.*</code>. Nesting is capped to prevent
            recursion.
          </div>

          <BindingsEditor
            bindings={
              obj("inputBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ inputBindings: v })}
          />

          <JsonField
            label="Static input (JSON)"
            value={obj("input")}
            placeholder={'{\n  "message": "hello"\n}'}
            onChange={(v) => onChange({ input: v })}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Leave input empty to forward this run's trigger input to the child.
          </div>
        </>
      )}

      {kind === "forEach" && (
        <>
          <Labeled label="Sub-workflow key (run per item)">
            <input
              value={str("workflowKey")}
              onChange={(e) => onChange({ workflowKey: e.target.value })}
              style={inputStyle}
              placeholder="process-one-item"
            />
          </Labeled>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Runs that saved workflow once per array item (item = the child's
            input), concurrently. Output is an array of{" "}
            <code>{node.id}.N.status</code> / <code>.output</code>, one per
            item. Capped at 100 items — filter first if larger.
          </div>
        </>
      )}

      {kind === "wait" && (
        <>
          <Labeled label="Wait mode">
            <select
              value={str("mode") || "duration"}
              onChange={(e) => onChange({ mode: e.target.value })}
              style={inputStyle}
            >
              <option value="duration">
                Duration — pause for a fixed time
              </option>
              <option value="webhook">
                Webhook — pause until an external system resumes
              </option>
            </select>
          </Labeled>
          {(str("mode") || "duration") === "webhook" ? (
            <>
              <Labeled label="Timeout (seconds, optional)">
                <input
                  type="number"
                  min={0}
                  value={num("timeoutSeconds") ?? ""}
                  onChange={(e) =>
                    onChange({
                      timeoutSeconds: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="wait forever"
                />
              </Labeled>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Pauses until an external system POSTs the run's resume URL
                (shown on the run page). Survives restarts for days. With a
                timeout it auto-continues on elapse; the node output is{" "}
                <code>
                  {"{"}resumed, timedOut, payload{"}"}
                </code>{" "}
                — branch on <code>{node.id}.resumed</code>.
              </div>
            </>
          ) : (
            <>
              <Labeled label="Wait (seconds)">
                <input
                  type="number"
                  min={0}
                  value={num("durationSeconds") ?? ""}
                  onChange={(e) =>
                    onChange({
                      durationSeconds: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="0"
                />
              </Labeled>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Pauses the run with a durable timer — it survives restarts and
                costs nothing while waiting.
              </div>
            </>
          )}
        </>
      )}

      {kind === "stopAndError" && (
        <>
          <Labeled label="Error message">
            <input
              value={str("message")}
              onChange={(e) => onChange({ message: e.target.value })}
              style={inputStyle}
              placeholder="Stopped: unexpected input"
            />
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Ends the run as <strong>failed</strong> with this message. Nothing
            downstream runs.
          </div>
        </>
      )}

      {kind === "respondToWebhook" && (
        <>
          <Labeled label="Status code">
            <input
              type="number"
              min={100}
              max={599}
              value={num("statusCode") ?? ""}
              onChange={(e) =>
                onChange({
                  statusCode: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="200"
            />
          </Labeled>
          <JsonField
            label="Response body (JSON)"
            value={config.body as Record<string, unknown> | undefined}
            placeholder={'{\n  "ok": true\n}'}
            onChange={(v) => onChange({ body: v })}
          />
          <BindingsEditor
            bindings={
              config.bodyBinding
                ? { body: config.bodyBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ bodyBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            For webhook-triggered graphs: returns this response to the caller
            synchronously, then the run continues. Bind <code>body</code> from
            an upstream output to override the static JSON.
          </div>
        </>
      )}

      {kind === "code" && (
        <>
          <div>
            <RowHead label="JavaScript" value="sandboxed" />
            <textarea
              value={str("code")}
              onChange={(e) => onChange({ code: e.target.value })}
              rows={8}
              spellCheck={false}
              className="mono"
              style={{ ...textareaStyle, fontFamily: "monospace" }}
              placeholder={
                "// $input = trigger input, $ctx = upstream outputs\nreturn { total: $input.a + $input.b };"
              }
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Timeout ms (≤5000)">
              <input
                type="number"
                min={1}
                max={5000}
                value={num("timeoutMs") ?? ""}
                onChange={(e) =>
                  onChange({
                    timeoutMs: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="2000"
              />
            </Labeled>
            <Labeled label="Memory MB (≤128)">
              <input
                type="number"
                min={1}
                max={128}
                value={num("memoryMb") ?? ""}
                onChange={(e) =>
                  onChange({
                    memoryMb: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="64"
              />
            </Labeled>
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Runs in a QuickJS/WASM sandbox — no network, no filesystem, capped
            time + memory. <code>return</code> a value; it becomes{" "}
            <code>{node.id}</code>'s output.
          </div>
        </>
      )}

      {kind === "humanApproval" && (
        <>
          <Labeled label="Approval title">
            <input
              value={str("title")}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
              placeholder="Approve refund?"
            />
          </Labeled>
          <Labeled label="Instructions">
            {exprText("instructions", {
              multiline: true,
              placeholder: "What the approver should check…",
            })}
          </Labeled>
          <Labeled label="Auto-reject after (hours)">
            <input
              type="number"
              min={0}
              step={1}
              value={num("timeoutHours") ?? ""}
              onChange={(e) =>
                onChange({
                  timeoutHours: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="blank = wait forever"
            />
          </Labeled>
        </>
      )}
    </>
  );
}
