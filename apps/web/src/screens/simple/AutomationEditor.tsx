import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button, Icon } from "../../components";
import { api, type ConnectionRow } from "../../lib/api";
import { type FriendlyField, friendlyStep } from "../../lib/friendly-catalog";
import { ACCENT, nodeDisplayLabel, nodeSubtitle } from "../../lib/graph-model";
import { orderedNodes } from "../../lib/graph-order";
import { edgeConditionLabel } from "../app/run-detail/run-view-model";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

type NodeDef = GraphDef["nodes"][number];

/** DSL trigger node types → the WHEN beat's single row. */
const TRIGGER_TYPES = new Set<string>([
  "start",
  "webhookTrigger",
  "scheduleTrigger",
  "formTrigger",
  "chatTrigger",
  "errorTrigger",
  "pollTrigger",
]);

/** Mono, node-tinted labels per beat (WHEN → DO → ASK → THEN). */
const BEAT_ACCENT: Record<string, string> = {
  WHEN: "var(--node-trigger)",
  DO: "var(--node-agent)",
  ASK: "var(--node-approval)",
  THEN: "var(--node-http)",
};

const slug = (s: string): string =>
  `${
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "automation"
  }-${Math.random().toString(36).slice(2, 6)}`;

const nodeTint = (type: string): string =>
  ACCENT[type as keyof typeof ACCENT] ?? "var(--ink-3)";

/** Plain-language name for a step (friendly title, else the node's display label). */
function stepTitle(node: NodeDef): string {
  return (
    friendlyStep(node.type)?.title ?? nodeDisplayLabel(node.type, node.config)
  );
}

/** A compact, real echo of a step's config (never invented). */
function stepSubtitle(node: NodeDef): string | undefined {
  return (
    nodeSubtitle(node.type, node.config ?? undefined) ??
    friendlyStep(node.type)?.blurb
  );
}

/**
 * Simple-mode BEAT-BLOCK editor (design PRODUCT-VARIANTS.md §4, redesign). Renders the
 * automation's REAL ordered steps grouped into labeled beats — WHEN (trigger) → DO
 * (actions/data/AI before any gate) → ASK (a human-approval gate) → THEN (the rest) —
 * a plain-language LENS over the same graph. Editing each step reuses the existing
 * friendly-catalog field UI, and Save / Test call the SAME api the canvas uses (a Simple
 * automation is a normal graph). Nothing about how it compiles or runs changes.
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
  const phone = useMediaQuery(PHONE_QUERY);
  const [name, setName] = useState(initialName);
  const [graph, setGraph] = useState<GraphDef>(initialGraph);
  const [workflowKey, setWorkflowKey] = useState(savedKey ?? "");
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  // Per-run budget cap = run-time truth shown always (honest "no cap" when unset).
  // "loading" until the tenant budget resolves; number = cap; null = no per-run cap.
  const [cap, setCap] = useState<number | null | "loading">("loading");
  const [busy, setBusy] = useState<null | "save" | "run">(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then(async (me) => {
        api
          .listConnections(me.tenantId)
          .then(setConnections)
          .catch(() => undefined);
        try {
          const b = await api.getBudget(me.tenantId);
          setCap(b.perExecutionCapUsd > 0 ? b.perExecutionCapUsd : null);
        } catch {
          setCap(null);
        }
      })
      .catch(() => setCap(null));
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

  // "Test" = the existing single-run action: save, start a real execution, then land on
  // the friendly run view (which resolves this automation's latest run).
  async function onTest() {
    setBusy("run");
    setStatus(null);
    try {
      const key = await save();
      const { workflowId } = await api.startExecution(key);
      // Hand the fresh run id to the detail view so it opens THIS run — never a
      // stale "latest" from listRuns (which may not have propagated yet).
      navigate(`/app/automations/${encodeURIComponent(key)}`, {
        state: { runId: workflowId },
      });
    } catch {
      // Save already ran above, so "try Save first" is misleading — the failure is the
      // save or the start itself. Point at the real causes.
      setStatus(
        "Couldn't start a test run — check your steps and AI connection.",
      );
      setBusy(null);
    }
  }

  function openInBuilder() {
    const key = workflowKey;
    navigate(
      key ? `/app/canvas?key=${encodeURIComponent(key)}` : "/app/canvas",
    );
  }

  /* ---------- Beat grouping (a relabel of the real ordered steps) ---------- */
  const steps = orderedNodes(graph);
  const entry = steps[0];
  const trigger = entry && TRIGGER_TYPES.has(entry.type) ? entry : null;
  const rest = steps.filter((s) => s !== trigger);
  const gateIdx = rest.findIndex((s) => s.type === "humanApproval");
  const gate = gateIdx >= 0 ? rest[gateIdx] : null;
  const doSteps = gateIdx >= 0 ? rest.slice(0, gateIdx) : rest;
  const thenSteps = gateIdx >= 0 ? rest.slice(gateIdx + 1) : [];
  // A real condition on the edge INTO the gate → the gate is conditional ("ONLY IF …").
  const gateCondition = gate
    ? (graph.edges.find((e) => e.to === gate.id && e.condition)?.condition ??
      null)
    : null;

  return (
    <div
      style={{
        padding: phone ? "16px 16px 40px" : "22px 28px 40px",
        maxWidth: 720,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      {/* ===== Header ===== */}
      <div
        style={{
          display: "flex",
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
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
              letterSpacing: "var(--tracking-tight)",
            }}
          />
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            {steps.length} step{steps.length === 1 ? "" : "s"} · saves to the
            same engine as Builder.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <BudgetCapPill cap={cap} />
          <Button
            variant="primary"
            icon="play"
            loading={busy === "run"}
            disabled={!!busy}
            onClick={onTest}
          >
            {busy === "run" ? "Starting…" : "Test"}
          </Button>
        </div>
      </div>

      {/* ===== Beats ===== */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {trigger && (
          <Beat label="WHEN">
            <StepRow
              node={trigger}
              connections={connections}
              onChange={setConfig}
            />
          </Beat>
        )}

        {doSteps.length > 0 && (
          <Beat label="DO" connectTop={!!trigger}>
            {doSteps.map((n) => (
              <StepRow
                key={n.id}
                node={n}
                connections={connections}
                onChange={setConfig}
              />
            ))}
          </Beat>
        )}

        {gate && (
          <Beat label="ASK" connectTop>
            <ApprovalCard
              gate={gate}
              conditionLabel={
                gateCondition ? edgeConditionLabel(gateCondition) : null
              }
              connections={connections}
              onChange={setConfig}
            />
          </Beat>
        )}

        <Beat
          label="THEN"
          connectTop={!!trigger || doSteps.length > 0 || !!gate}
        >
          {thenSteps.map((n) => (
            <StepRow
              key={n.id}
              node={n}
              connections={connections}
              onChange={setConfig}
            />
          ))}
          <AddStepRow onClick={openInBuilder} />
        </Beat>
      </div>

      {/* ===== Footer ===== */}
      <div
        style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}
      >
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
      <div
        style={{
          marginTop: 16,
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
        }}
      >
        This is the same automation Builder draws as a graph —{" "}
        <button
          type="button"
          onClick={openInBuilder}
          style={{
            all: "unset",
            cursor: "pointer",
            color: "var(--brand)",
            fontWeight: "var(--weight-medium, 500)",
          }}
        >
          Open in Builder
        </button>{" "}
        anytime.
      </div>
    </div>
  );
}

/* ---------------- Beat block (label + tinted rail + connector) ---------------- */
function Beat({
  label,
  connectTop = false,
  children,
}: {
  label: string;
  connectTop?: boolean;
  children: React.ReactNode;
}) {
  const accent = BEAT_ACCENT[label] ?? "var(--ink-3)";
  return (
    <div style={{ position: "relative" }}>
      {connectTop && (
        <div
          aria-hidden
          style={{
            width: 2,
            height: 16,
            margin: "0 0 0 5px",
            background: "var(--line-2)",
          }}
        />
      )}
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          letterSpacing: ".08em",
          fontWeight: "var(--weight-bold)",
          color: accent,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

/* ---------------- One step row (icon + plain text + edit affordance) ---------------- */
function StepRow({
  node,
  connections,
  onChange,
}: {
  node: NodeDef;
  connections: ConnectionRow[];
  onChange: (nodeId: string, key: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const friendly = friendlyStep(node.type);
  const config = (node.config ?? {}) as Record<string, unknown>;
  const editable = !!friendly && friendly.fields.length > 0;
  const tint = nodeTint(node.type);
  const subtitle = stepSubtitle(node);

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
      <div
        style={{ display: "flex", alignItems: "center", gap: 12, padding: 14 }}
      >
        <span
          style={{
            flex: "none",
            width: 30,
            height: 30,
            borderRadius: "var(--radius-md)",
            background: `color-mix(in srgb, ${tint} 16%, transparent)`,
            color: tint,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={nodeIconFor(node.type)} size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {stepTitle(node)}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {editable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 5,
              minHeight: 44,
              padding: "0 6px",
              color: "var(--ink-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            {open ? "Done" : "Edit"}
            <Icon
              name="chevron-down"
              size={14}
              style={{
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform .15s ease",
              }}
            />
          </button>
        ) : (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            advanced
          </span>
        )}
      </div>

      {open && editable && (
        <div
          style={{
            borderTop: "1px solid var(--line)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            background: "var(--card-2)",
          }}
        >
          {friendly.fields.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={config[f.key]}
              connections={connections}
              onChange={(v) => onChange(node.id, f.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- ASK: the human-approval gate card ---------------- */
function ApprovalCard({
  gate,
  conditionLabel,
  connections,
  onChange,
}: {
  gate: NodeDef;
  conditionLabel: string | null;
  connections: ConnectionRow[];
  onChange: (nodeId: string, key: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const friendly = friendlyStep(gate.type);
  const config = (gate.config ?? {}) as Record<string, unknown>;
  const title =
    (typeof config.title === "string" && config.title.trim()) ||
    "the result before it continues";
  // Approver: never fabricated — the gate's config, else the honest "a person".
  const approver =
    (typeof config.approver === "string" && config.approver.trim()) ||
    (typeof config.assignee === "string" && config.assignee.trim()) ||
    "a person";

  return (
    <div
      style={{
        background: "var(--card)",
        border:
          "1px solid color-mix(in srgb, var(--node-approval) 40%, var(--line))",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          style={{
            flex: "none",
            width: 30,
            height: 30,
            borderRadius: "var(--radius-md)",
            background:
              "color-mix(in srgb, var(--node-approval) 16%, transparent)",
            color: "var(--node-approval)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="approval" size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {conditionLabel && (
            <div
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginBottom: 4,
              }}
            >
              ONLY IF {conditionLabel}
            </div>
          )}
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            Ask {approver} to approve {title}
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            Pauses here until someone decides — it can wait for days, then
            continues on approve and stops on reject.
          </div>
          {conditionLabel && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
                marginTop: 4,
              }}
            >
              OTHERWISE continue automatically.
            </div>
          )}
        </div>
        {friendly && friendly.fields.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 5,
              minHeight: 44,
              padding: "0 6px",
              color: "var(--ink-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            {open ? "Done" : "Edit"}
          </button>
        )}
      </div>
      {open && friendly && friendly.fields.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {friendly.fields.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={config[f.key]}
              connections={connections}
              onChange={(v) => onChange(gate.id, f.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Add-a-step affordance ---------------- */
function AddStepRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        padding: "10px 14px",
        borderRadius: "var(--radius-lg)",
        border: "1px dashed var(--line-2)",
        color: "var(--ink-2)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Icon name="plus" size={14} />
      Add a step in Builder
    </button>
  );
}

/* ---------------- Node → icon (Simple mode's small tinted glyphs) ---------------- */
function nodeIconFor(
  type: string,
):
  | "bolt"
  | "agent"
  | "mcp"
  | "http"
  | "approval"
  | "clock"
  | "grid"
  | "end"
  | "edit" {
  if (TRIGGER_TYPES.has(type)) return "bolt";
  switch (type) {
    case "agent":
    case "codeAgent":
      return "agent";
    case "mcpTool":
    case "integration":
      return "mcp";
    case "httpRequest":
    case "graphQL":
    case "rssRead":
    case "sendEmail":
    case "respondToWebhook":
      return "http";
    case "sqlQuery":
    case "sqlExec":
      return "grid";
    case "humanApproval":
      return "approval";
    case "wait":
      return "clock";
    case "end":
      return "end";
    default:
      return "edit";
  }
}

/* ---------------- Field editor (unchanged — reuses the friendly-catalog UI) ---------------- */
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

/* ---------------- Budget-cap pill (run-time truth, always shown) ---------------- */
function BudgetCapPill({ cap }: { cap: number | null | "loading" }) {
  const text =
    cap === "loading"
      ? "…"
      : cap === null
        ? "No per-run cap"
        : `$${cap.toFixed(2)} / run`;
  return (
    <span
      title="The most this automation can spend in a single run"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 10px",
        borderRadius: "var(--radius-pill)",
        border: "1px solid var(--line-2)",
        background: "var(--surface)",
        color: cap === null ? "var(--ink-3)" : "var(--ink-2)",
        fontSize: "var(--text-xs)",
        whiteSpace: "nowrap",
      }}
    >
      <Icon name="dollar" size={12} />
      {text}
    </span>
  );
}
