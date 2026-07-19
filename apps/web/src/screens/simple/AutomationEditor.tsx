import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button } from "../../components";
import { api, type ConnectionRow } from "../../lib/api";
import { type FriendlyField, friendlyStep } from "../../lib/friendly-catalog";
import { orderedNodes } from "../../lib/graph-order";

type NodeDef = GraphDef["nodes"][number];

const slug = (s: string): string =>
  `${
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "automation"
  }-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Simple-mode step-list editor (design PRODUCT-VARIANTS.md §4). Renders a graph as an ordered list
 * of friendly step cards, edits a curated subset of each node's config, then saves + runs via the
 * SAME api the canvas uses (a Simple automation is a normal graph). Unsupported node types show
 * read-only with "open in Builder".
 */
export function AutomationEditor({
  initialName,
  initialGraph,
  workflowKey: savedKey,
}: {
  initialName: string;
  initialGraph: GraphDef;
  workflowKey?: string;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(initialName);
  const [graph, setGraph] = useState<GraphDef>(initialGraph);
  const [workflowKey, setWorkflowKey] = useState(savedKey ?? "");
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [busy, setBusy] = useState<null | "save" | "run">(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then((me) => api.listConnections(me.tenantId))
      .then(setConnections)
      .catch(() => undefined);
  }, []);

  const setConfig = useCallback(
    (nodeId: string, key: string, value: unknown) => {
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, config: { ...(n.config ?? {}), [key]: value } }
            : n,
        ),
      }));
      setStatus(null);
    },
    [],
  );

  async function save(): Promise<string> {
    const key = workflowKey || slug(name);
    await api.saveGraph(key, name.trim() || "Automation", graph);
    setWorkflowKey(key);
    return key;
  }

  async function onSave() {
    setBusy("save");
    setStatus(null);
    try {
      await save();
      setStatus("Saved.");
    } catch {
      setStatus("Could not save — check the steps and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onRun() {
    setBusy("run");
    setStatus(null);
    try {
      const key = await save();
      const { workflowId } = await api.startExecution(key);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch {
      setStatus("Could not run it — try Save first.");
      setBusy(null);
    }
  }

  const steps = orderedNodes(graph);

  return (
    <div
      style={{
        padding: "22px 28px 40px",
        maxWidth: 720,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name your automation"
        style={{
          width: "100%",
          fontSize: "var(--text-title)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          background: "transparent",
          border: "none",
          outline: "none",
          marginBottom: 4,
        }}
      />
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink-2)",
          marginBottom: 20,
        }}
      >
        {steps.length} step{steps.length === 1 ? "" : "s"} · runs on the same
        durable engine as Builder mode.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {steps.map((node, i) => (
          <StepCard
            key={node.id}
            index={i + 1}
            node={node}
            connections={connections}
            onChange={(key, value) => setConfig(node.id, key, value)}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <Button
          variant="primary"
          icon="bolt"
          loading={busy === "run"}
          disabled={!!busy}
          onClick={onRun}
        >
          {busy === "run" ? "Starting…" : "Run now"}
        </Button>
        <Button
          variant="secondary"
          loading={busy === "save"}
          disabled={!!busy}
          onClick={onSave}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        {status && (
          <span
            style={{
              alignSelf: "center",
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

function StepCard({
  index,
  node,
  connections,
  onChange,
}: {
  index: number;
  node: NodeDef;
  connections: ConnectionRow[];
  onChange: (key: string, value: unknown) => void;
}) {
  const friendly = friendlyStep(node.type);
  const config = (node.config ?? {}) as Record<string, unknown>;

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: 16,
      }}
    >
      <div
        style={{
          flex: "none",
          width: 26,
          height: 26,
          borderRadius: "var(--radius-full)",
          background: friendly?.accent ?? "var(--line-2)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-bold)",
        }}
      >
        {index}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          {friendly?.title ?? `Advanced step (${node.type})`}
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginTop: 2,
          }}
        >
          {friendly?.blurb ??
            "This step has advanced settings — open it in Builder mode to edit."}
        </div>

        {friendly && friendly.fields.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginTop: 12,
            }}
          >
            {friendly.fields.map((f) => (
              <Field
                key={f.key}
                field={f}
                value={config[f.key]}
                connections={connections}
                onChange={(v) => onChange(f.key, v)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--bg)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};

function Field({
  field,
  value,
  connections,
  onChange,
}: {
  field: FriendlyField;
  value: unknown;
  connections: ConnectionRow[];
  onChange: (v: unknown) => void;
}) {
  const str = typeof value === "string" ? value : (value ?? "");
  const label = (
    <div
      style={{
        fontSize: "var(--text-sm)",
        color: "var(--ink-2)",
        marginBottom: 4,
      }}
    >
      {field.label}
    </div>
  );

  if (field.kind === "connection") {
    const matches = connections.filter((c) =>
      (field.connectionTypes ?? []).includes(c.type),
    );
    return (
      <label style={{ display: "block" }}>
        {label}
        <select
          value={String(str)}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        >
          <option value="">
            {matches.length ? "Choose…" : "No connection — add one in Settings"}
          </option>
          {matches.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label style={{ display: "block" }}>
        {label}
        <select
          value={String(str)}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "textarea") {
    return (
      <label style={{ display: "block" }}>
        {label}
        <textarea
          value={String(str)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>
    );
  }
  return (
    <label style={{ display: "block" }}>
      {label}
      <input
        type={field.kind === "number" ? "number" : "text"}
        value={String(str)}
        onChange={(e) =>
          onChange(
            field.kind === "number"
              ? e.target.value === ""
                ? undefined
                : Number(e.target.value)
              : e.target.value,
          )
        }
        placeholder={field.placeholder}
        style={inputStyle}
      />
      {field.help && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginTop: 3,
          }}
        >
          {field.help}
        </div>
      )}
    </label>
  );
}
