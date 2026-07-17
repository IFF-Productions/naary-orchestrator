import "@xyflow/react/dist/style.css";
import {
  Background,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { GraphDef, NodeType } from "@naary/dsl";
import { Button, Card, Icon } from "../../components";
import {
  api,
  type NamedGraph,
  UnauthorizedError,
  type WebhookRow,
} from "../../lib/api";
import { decompileGraph } from "../../lib/decompile-graph";
import { ACCENT, nodeDisplayLabel, nodeSubtitle } from "../../lib/graph-model";
import { WorkflowDiffPanel } from "./WorkflowDiffPanel";

interface ViewData extends Record<string, unknown> {
  kind: NodeType;
  // Provider-aware label (a GitHub integration reads "GitHub", not "Notion"), resolved
  // from the node config at build time since ViewData doesn't carry the raw config.
  label: string;
  subtitle?: string;
}

/** Read-only node (no editing). Handles anchor the existing edges. */
function ViewNode({ data }: NodeProps<Node<ViewData>>) {
  const accent = ACCENT[data.kind];
  const isEntry =
    data.kind === "start" ||
    data.kind === "webhookTrigger" ||
    data.kind === "errorTrigger";
  return (
    <div
      style={{
        minWidth: 132,
        borderRadius: "var(--radius-md)",
        border: `1px solid ${accent}`,
        background: "var(--card)",
        color: "var(--ink)",
        fontSize: "var(--text-body)",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,.18)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div style={{ height: 4, background: accent }} />
      <div
        style={{ padding: "9px 12px", fontWeight: "var(--weight-semibold)" }}
      >
        {data.label}
      </div>
      {data.subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 12px 9px",
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
          }}
        >
          {data.subtitle}
        </div>
      )}
      {data.kind !== "end" && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
const nodeTypes = { view: ViewNode };

function edgeLabel(c?: {
  path: string;
  op: string;
  value: string;
}): string | undefined {
  if (!c || !c.path.trim()) return undefined;
  return c.op === "exists"
    ? `${c.path} exists`
    : `${c.path} ${c.op} ${c.value}`;
}

export function WorkflowDetail() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const [g, setG] = useState<NamedGraph | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<{ workflowKey: string }[]>([]);
  const [errWk, setErrWk] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getGraph(key)
      .then((res) => live && setG(res))
      .catch(
        (e) =>
          live &&
          setError(
            e instanceof UnauthorizedError
              ? "Not authenticated."
              : `Couldn't load workflow '${key}'.`,
          ),
      );
    api
      .getMe()
      .then((me) => api.listWebhooks(me.tenantId))
      .then((ws) => live && setWebhooks(ws))
      .catch(() => undefined);
    api
      .listGraphs()
      .then((ws) => live && setWorkflows(ws))
      .catch(() => undefined);
    api
      .getErrorHandler(key)
      .then((r) => live && setErrWk(r.errorWorkflowKey))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);

  async function bindErrorHandler(value: string | null): Promise<void> {
    setErrWk(value);
    await api.setErrorHandler(key, value).catch(() => undefined);
  }

  const flow = g ? toFlow(g.graph) : null;
  const entry = g?.graph.nodes.find((n) => n.id === g.graph.startNodeId);
  const isWebhook = entry?.type === "webhookTrigger";
  const hookUrls = webhooks
    .filter((w) => w.workflowId === key)
    .map((w) => `/hooks/${w.id}`);

  async function run(): Promise<void> {
    try {
      const { workflowId } = await api.startExecution(key);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch {
      setError("Could not start a run.");
    }
  }

  return (
    <div style={{ padding: "22px 28px 40px" }}>
      <button
        type="button"
        onClick={() => navigate("/app/workflows")}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--ink-2)",
          fontSize: "var(--text-body)",
          padding: 0,
          marginBottom: 12,
        }}
      >
        ← Workflows
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            {g?.name ?? key}
          </div>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 4,
            }}
          >
            {key}
            {g ? ` · v${g.version}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <Button icon="play" onClick={run}>
            Run now
          </Button>
          <Button
            variant="secondary"
            icon="edit"
            onClick={() =>
              navigate(`/app/canvas?key=${encodeURIComponent(key)}`)
            }
          >
            Open in canvas
          </Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            fontSize: "var(--text-body)",
            color: "var(--state-error)",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 16 }}
      >
        {/* the decision tree */}
        <Card pad={false} style={{ height: 460, overflow: "hidden" }}>
          {flow && (
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
            </ReactFlow>
          )}
        </Card>

        {/* how it runs */}
        <Card style={{ padding: 18 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              marginBottom: 10,
            }}
          >
            How it runs
          </div>
          <p
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              lineHeight: 1.6,
              marginTop: 0,
            }}
          >
            The interpreter walks this graph from the entry node, following each
            edge whose condition holds. Agent/tool nodes do work; an approval
            node pauses the run until someone decides; the run ends at a
            terminal node.
          </p>
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              marginTop: 14,
            }}
          >
            Triggers
          </div>
          <ul
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              lineHeight: 1.7,
              paddingLeft: 18,
              marginTop: 6,
            }}
          >
            <li>
              <strong>Manual</strong> — “Run now” here, or from the Runs screen.
            </li>
            <li>
              <strong>Schedule</strong> — run on a cron from the Schedules
              screen.
            </li>
            {isWebhook ? (
              <li>
                <strong>Webhook</strong> —{" "}
                {hookUrls.length > 0 ? (
                  <>
                    {hookUrls.map((u) => (
                      <code key={u} style={{ fontSize: "var(--text-xs)" }}>
                        POST {u}
                      </code>
                    ))}
                    <div
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                        marginTop: 4,
                      }}
                    >
                      Signed <code>POST</code>: send{" "}
                      <code>
                        X-Hub-Signature-256: sha256=&lt;HMAC-SHA256(body,
                        secret)&gt;
                      </code>{" "}
                      over the raw body. The full copy-run <code>curl</code> is
                      shown when you register the endpoint (Integrations).
                    </div>
                  </>
                ) : (
                  <>register an endpoint on the Integrations screen.</>
                )}
              </li>
            ) : (
              <li>
                <strong>Webhook</strong> — add a Webhook trigger node to enable.
              </li>
            )}
          </ul>
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              marginTop: 14,
            }}
          >
            Error workflow
          </div>
          <p
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              lineHeight: 1.6,
              margin: "6px 0 8px",
            }}
          >
            If this workflow fails, run this handler (a graph that starts with
            an <strong>Error Trigger</strong>) with the failure context.
          </p>
          <select
            aria-label="Error workflow"
            value={errWk ?? ""}
            onChange={(e) => void bindErrorHandler(e.target.value || null)}
            style={{
              width: "100%",
              padding: "7px 9px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
            }}
          >
            <option value="">— none —</option>
            {workflows
              .filter((w) => w.workflowKey !== key)
              .map((w) => (
                <option key={w.workflowKey} value={w.workflowKey}>
                  {w.workflowKey}
                </option>
              ))}
          </select>
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              marginTop: 14,
            }}
          >
            Nodes ({g?.graph.nodes.length ?? 0})
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
          >
            {g?.graph.nodes.map((n) => (
              <span
                key={n.id}
                style={{
                  fontSize: "var(--text-2xs)",
                  border: `1px solid ${ACCENT[n.type]}`,
                  color: ACCENT[n.type],
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 8px",
                }}
              >
                {nodeDisplayLabel(n.type, n.config)}
              </span>
            ))}
          </div>
        </Card>
      </div>

      {/* Compare two saved versions — review structural changes before promoting. */}
      <WorkflowDiffPanel workflowKey={key} />
    </div>
  );
}

function toFlow(graph: GraphDef): {
  nodes: Node<ViewData>[];
  edges: Edge[];
} {
  const { nodes, edges } = decompileGraph(graph);
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "view",
      position: n.position,
      data: {
        kind: n.type,
        label: nodeDisplayLabel(n.type, n.config),
        subtitle: nodeSubtitle(n.type, n.config),
      },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: edgeLabel(e.condition),
    })),
  };
}
