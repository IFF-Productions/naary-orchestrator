/**
 * The failing HTTP call, on the step card (#916).
 *
 * Reported as *"it always says no recorded output for this step, there should be some logs about
 * request/response."* A node that throws writes nothing to ctx, so the most diagnostic moment in a
 * run produced the least data — the message string and nothing else. This renders what the worker
 * captured at the moment of failure: the resolved method/URL, the headers, and both bodies.
 *
 * COLLAPSED by default, following CodeAgentTrace in this folder: the summary line (method, status,
 * URL) answers "what broke" at a glance, and only someone actually debugging wants the bodies.
 *
 * Everything here is already redacted and truncated by the worker before it entered Temporal
 * history — this component never un-redacts anything and has nothing to un-redact. A `[REDACTED]`
 * header value is rendered dimmed and verbatim, on purpose: knowing that an `authorization` header
 * WAS sent is half the diagnosis for a 401.
 */
import { useState } from "react";
import type { HttpFailure, HttpFailureBody } from "../../../lib/api";

function kib(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: "var(--ink-faint)",
        margin: "10px 0 5px",
      }}
    >
      {children}
    </div>
  );
}

function HeaderList({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return (
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
        No headers recorded.
      </div>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {entries.map(([name, value]) => {
        const redacted = value === "[REDACTED]";
        return (
          <li
            key={name}
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              lineHeight: 1.7,
              wordBreak: "break-all",
            }}
          >
            <span style={{ color: "var(--ink-soft)" }}>{name}: </span>
            <span
              style={{
                color: redacted ? "var(--ink-faint)" : "var(--ink-3)",
                fontStyle: redacted ? "italic" : "normal",
              }}
            >
              {value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Body({ body }: { body: HttpFailureBody }) {
  return (
    <>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: "8px 10px",
          maxHeight: 220,
          overflow: "auto",
          border: "1px solid var(--line)",
          borderRadius: 6,
          background: "var(--bg)",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-soft)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {body.text}
      </pre>
      {body.truncated && (
        <div
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-faint)",
            marginTop: 4,
          }}
        >
          Truncated — the original body was {kib(body.bytes)}.
        </div>
      )}
    </>
  );
}

export function HttpFailureDetail({ http }: { http: HttpFailure }) {
  const [open, setOpen] = useState(false);
  const { request, response } = http;

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "none",
          border: "1px solid var(--line-mid)",
          borderRadius: 8,
          padding: "8px 12px",
          cursor: "pointer",
          color: "var(--ink-soft)",
          fontSize: "var(--text-xs)",
          textAlign: "left",
        }}
        aria-expanded={open}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        <span style={{ fontWeight: "var(--weight-semibold)" }}>
          Request / response
        </span>
        <span
          style={{
            color: "var(--ink-3)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {request.method}
          {response ? ` → ${response.status}` : " → no response"} ·{" "}
          {request.url}
        </span>
      </button>
      {open && (
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "10px 12px 14px",
            marginTop: 8,
          }}
        >
          <SubLabel>Request</SubLabel>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink)",
              wordBreak: "break-all",
              marginBottom: 6,
            }}
          >
            {request.method} {request.url}
          </div>
          <HeaderList headers={request.headers} />
          {request.body && (
            <>
              <SubLabel>Request body</SubLabel>
              <Body body={request.body} />
            </>
          )}
          {/* The reason is already a full sentence from the worker ("withheld — this request
              body carried a resolved $secret"), so it's rendered as-is under the same label the
              body would have had — prefixing it would say "request body" twice. */}
          {request.bodyWithheld && (
            <>
              <SubLabel>Request body</SubLabel>
              <div
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-faint)",
                  fontStyle: "italic",
                }}
              >
                {request.bodyWithheld}
              </div>
            </>
          )}

          <SubLabel>Response</SubLabel>
          {response ? (
            <>
              <div
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--state-error)",
                  marginBottom: 6,
                }}
              >
                {response.status}
                {response.statusText ? ` ${response.statusText}` : ""}
              </div>
              <HeaderList headers={response.headers} />
              {response.body ? (
                <>
                  <SubLabel>Response body</SubLabel>
                  <Body body={response.body} />
                </>
              ) : (
                <div
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  The response had an empty body.
                </div>
              )}
            </>
          ) : (
            // No response at all — a DNS/TLS/timeout/egress failure. Say that, rather than
            // rendering a status 0 the reader would take for a real one.
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              No response was received — the call failed before the server
              answered.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
