// Shared inspector building blocks: field components, connection picker, style constants (extracted from CanvasPage).
import { useState } from "react";
import type { NodeType } from "@naary/dsl";
import type { ConnectionRow } from "../../lib/api";
import {
  CONDITION_OPS,
  type EdgeConditionDraft,
  VALUELESS_OPS,
} from "../../lib/graph-model";
import { RowHead } from "./PinSection";

/** Provider/model options the runtime actually supports today. Must stay in sync with the
 *  worker's buildModel() (the providers it can construct) + MODEL_PRICING (so runs are billed) —
 *  offering a provider/model outside those would author nodes that fail or misbill at run time. */
export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

/** One upstream→argument binding row in the mcpTool editor. */
export interface BindingRow {
  from: string;
  path?: string;
}

/** Which connection types each connection-based node can use — mirrors the Integrations
 *  forms (MCP servers = github/atlassian/custom; DB engines; smtp; signing). */
export const CONNECTION_TYPES: Record<string, ConnectionRow["type"][]> = {
  mcpTool: ["github", "atlassian", "custom"],
  integration: ["github", "atlassian", "custom"],
  // codeAgent write mode authorizes the clone + PR via a GitHub App connection.
  codeAgent: ["github"],
  httpRequest: ["github", "atlassian", "custom"],
  sqlQuery: ["postgres", "mssql", "mysql"],
  sqlExec: ["postgres", "mssql", "mysql"],
  sendEmail: ["smtp"],
  hmac: ["signing"],
  jwt: ["signing"],
  totp: ["signing"],
};

/** Pick a connection by LABEL instead of pasting a raw connectionId. Filtered to the node's
 *  connection types; keeps an unknown current value visible so older configs don't break. */
export function ConnectionSelect({
  connections,
  types,
  value,
  onChange,
}: {
  connections: ConnectionRow[];
  types: readonly ConnectionRow["type"][];
  value: string;
  onChange: (id: string) => void;
}) {
  const matches = connections.filter((c) => types.includes(c.type));
  const hasCurrent = !!value && matches.some((c) => c.id === value);
  return (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      >
        <option value="">
          {matches.length ? "Select a connection…" : "No matching connections"}
        </option>
        {matches.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} ({c.type})
          </option>
        ))}
        {value && !hasCurrent && (
          <option value={value}>{value} (current)</option>
        )}
      </select>
      {matches.length === 0 && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginTop: 4,
          }}
        >
          No matching connection yet — add one on the Integrations screen, then
          reopen this node.
        </div>
      )}
    </>
  );
}

/** A JSON object field: edits as text, commits the parsed object on valid JSON,
 *  shows an inline error otherwise (last valid value stays in the config). Empty
 *  text clears the field (undefined). */
/** "true"/"false" → boolean, numeric string → number, else the trimmed string.
 *  Mirrors compile-graph's edge-condition coercion so the filter predicate's typed
 *  comparisons (===, >) work. */
function coerceCond(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/** Ops whose value is kept as a verbatim string (never numeric-coerced). */
const STRING_OPS = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
];

/** Node kinds that call activities / can genuinely fail — the ones "On error" applies to. */
export const ERRORABLE_KINDS = new Set<NodeType>([
  "agent",
  "codeAgent",
  "mcpTool",
  "httpRequest",
  "sqlQuery",
  "sqlExec",
  "sendEmail",
  "rssRead",
  "xml",
  "dateTime",
  "code",
  "hmac",
  "jwt",
  "totp",
  "executeSubWorkflow",
  "forEach",
  "pollTrigger",
]);

/** Node kinds whose activity is idempotent-ish enough to safely retry (per-node retry).
 *  Excludes the at-most-once nodes (sqlExec/sendEmail/code) where a retry could double-act. */
export const RETRYABLE_KINDS = new Set<NodeType>([
  "agent",
  "mcpTool",
  "httpRequest",
  "sqlQuery",
  "rssRead",
]);

/** Editor for a structured predicate (path/op/value) stored as a DSL EdgeCondition
 *  on the filter node's config. Coerces the value on change (like the edge editor). */
export function ConditionEditor({
  condition,
  onChange,
}: {
  condition?: { path?: string; op?: string; value?: unknown };
  onChange: (c: { path: string; op: string; value?: unknown }) => void;
}) {
  const path = condition?.path ?? "";
  const op = (condition?.op as EdgeConditionDraft["op"]) ?? "eq";
  const valStr = Array.isArray(condition?.value)
    ? (condition?.value as unknown[]).join(", ")
    : condition?.value === undefined || condition?.value === null
      ? ""
      : String(condition?.value);

  function build(nextPath: string, nextOp: string, nextVal: string): void {
    const c: { path: string; op: string; value?: unknown } = {
      path: nextPath,
      op: nextOp,
    };
    if (nextOp === "in") {
      c.value = nextVal
        .split(",")
        .map((s) => coerceCond(s.trim()))
        .filter((v) => v !== "");
    } else if (VALUELESS_OPS.includes(nextOp as EdgeConditionDraft["op"])) {
      // exists / isEmpty / notEmpty carry no value
    } else if (STRING_OPS.includes(nextOp)) {
      c.value = nextVal; // keep verbatim (regex pattern, "42" stays a string)
    } else {
      c.value = coerceCond(nextVal);
    }
    onChange(c);
  }

  return (
    <>
      <Labeled label="Item path">
        <input
          value={path}
          onChange={(e) => build(e.target.value, op, valStr)}
          style={inputStyle}
          placeholder="active"
        />
      </Labeled>
      <Labeled label="Operator">
        <select
          value={op}
          onChange={(e) => build(path, e.target.value, valStr)}
          style={inputStyle}
        >
          {CONDITION_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Labeled>
      {!VALUELESS_OPS.includes(op) && (
        <Labeled
          label={
            op === "in"
              ? "Values (comma-separated)"
              : op === "regex"
                ? "Pattern (JS regex)"
                : "Value"
          }
        >
          <input
            value={valStr}
            onChange={(e) => build(path, op, e.target.value)}
            style={inputStyle}
            placeholder={op === "in" ? "active, pending" : "true"}
          />
        </Labeled>
      )}
    </>
  );
}

export function JsonField({
  label,
  value,
  placeholder,
  onChange,
  allowArray = false,
}: {
  label: string;
  value: unknown;
  placeholder?: string;
  onChange: (v: unknown) => void;
  /** Accept a top-level JSON ARRAY as well as an object (e.g. an integration `json` field
   *  like Notion's block `children`). Default: object-only (mcpTool args, etc.). */
  allowArray?: boolean;
}) {
  const [text, setText] = useState(
    value !== undefined && value !== null ? JSON.stringify(value, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);

  function commit(next: string) {
    setText(next);
    const trimmed = next.trim();
    if (!trimmed) {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const isObject =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      const isArray = Array.isArray(parsed);
      if (!isObject && !(allowArray && isArray)) {
        setError(
          allowArray
            ? "Must be a JSON object or array"
            : "Must be a JSON object",
        );
        return;
      }
      setError(null);
      onChange(parsed);
    } catch {
      setError("Invalid JSON");
    }
  }

  return (
    <div>
      <RowHead label={label} value={error ? "⚠ error" : "JSON"} />
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        rows={5}
        spellCheck={false}
        className="mono"
        style={{
          ...textareaStyle,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
      />
      {error && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--state-error)",
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Like JsonField, but the value must be a JSON ARRAY (the sqlQuery params list). */
export function JsonArrayField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: unknown[] | undefined;
  placeholder?: string;
  onChange: (v: unknown[] | undefined) => void;
}) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  const [error, setError] = useState<string | null>(null);

  function commit(next: string) {
    setText(next);
    const trimmed = next.trim();
    if (!trimmed) {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        setError("Must be a JSON array");
        return;
      }
      setError(null);
      onChange(parsed as unknown[]);
    } catch {
      setError("Invalid JSON");
    }
  }

  return (
    <div>
      <RowHead label={label} value={error ? "⚠ error" : "JSON"} />
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        rows={3}
        spellCheck={false}
        className="mono"
        style={{
          ...textareaStyle,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
      />
      {error && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--state-error)",
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Editor for mcpTool argumentBindings: argName → { from: nodeId, path? }. This is
 *  how data threads between nodes (an arg bound to an upstream node's output). */
export function BindingsEditor({
  bindings,
  upstreamIds,
  onChange,
}: {
  bindings: Record<string, BindingRow> | undefined;
  upstreamIds: string[];
  onChange: (v: Record<string, BindingRow> | undefined) => void;
}) {
  const entries = Object.entries(bindings ?? {});

  function setEntry(oldName: string, name: string, row: BindingRow): void {
    const next: Record<string, BindingRow> = {};
    for (const [k, v] of entries) {
      if (k === oldName) continue;
      next[k] = v;
    }
    if (name.trim()) next[name.trim()] = row;
    onChange(Object.keys(next).length ? next : undefined);
  }
  function remove(name: string): void {
    const next = Object.fromEntries(entries.filter(([k]) => k !== name));
    onChange(Object.keys(next).length ? next : undefined);
  }
  function add(): void {
    const next = { ...(bindings ?? {}), "": { from: upstreamIds[0] ?? "" } };
    onChange(next);
  }

  return (
    <div>
      <RowHead label="Argument bindings" value={`${entries.length} bound`} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map(([name, row], i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, names are editable/duplicable
            key={i}
            style={{
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={name}
                onChange={(e) => setEntry(name, e.target.value, row)}
                style={{ ...inputStyle, flex: 1 }}
                placeholder="arg name"
              />
              <button
                type="button"
                aria-label="Remove binding"
                onClick={() => remove(name)}
                style={{
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-3)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "0 9px",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <select
                value={row.from}
                onChange={(e) =>
                  setEntry(name, name, { ...row, from: e.target.value })
                }
                style={{ ...inputStyle, flex: 1 }}
              >
                {upstreamIds.length === 0 && (
                  <option value="">(no nodes)</option>
                )}
                {upstreamIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <input
                value={row.path ?? ""}
                onChange={(e) =>
                  setEntry(name, name, {
                    ...row,
                    path: e.target.value || undefined,
                  })
                }
                style={{ ...inputStyle, flex: 1 }}
                placeholder="path (e.g. output.category)"
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          style={{
            border: "1px dashed var(--line-2)",
            background: "transparent",
            color: "var(--ink-2)",
            borderRadius: "var(--radius-md)",
            padding: 8,
            fontSize: "var(--text-xs)",
            cursor: "pointer",
          }}
        >
          + Add binding
        </button>
      </div>
    </div>
  );
}

export function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: "var(--text-sm)" }}>
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
export const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  fontFamily: "var(--font-sans)",
};
export const headerInputStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
