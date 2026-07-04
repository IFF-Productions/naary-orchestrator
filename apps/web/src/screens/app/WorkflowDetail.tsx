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
import { NODE_KINDS } from "../../lib/graph-model";

/** DSL node type → accent + label (kept local; the design's palette vars). */
const ACCENT: Record<NodeType, string> = {
  start: "var(--node-trigger)",
  webhookTrigger: "var(--node-trigger)",
  errorTrigger: "var(--node-error, #d6584f)",
  agent: "var(--node-agent)",
  mcpTool: "var(--node-mcp)",
  httpRequest: "var(--node-http, #2f9e8f)",
  sqlQuery: "var(--node-sql, #b06fd6)",
  set: "var(--node-set, #d98a3d)",
  renameKeys: "var(--node-rename, #c9803e)",
  filter: "var(--node-filter, #3f9e8f)",
  aggregate: "var(--node-aggregate, #b0863e)",
  listOps: "var(--node-listops, #4f9e7f)",
  compareDatasets: "var(--node-compare, #7f8f4f)",
  xml: "var(--node-xml, #8f6f4f)",
  html: "var(--node-html2, #4f7f8f)",
  markdown: "var(--node-md, #6f8f5f)",
  csv: "var(--node-csv, #8f7f4f)",
  dateTime: "var(--node-datetime, #6f8fd6)",
  merge: "var(--node-merge, #3fae86)",
  hmac: "var(--node-hmac, #a86fd6)",
  jwt: "var(--node-jwt, #7a6fd6)",
  totp: "var(--node-totp, #9a6fc6)",
  sendEmail: "var(--node-email, #4f9ad6)",
  rssRead: "var(--node-rss, #d98a5a)",
  executeSubWorkflow: "var(--node-subflow, #5b8def)",
  forEach: "var(--node-foreach, #5b6fd6)",
  wait: "var(--node-wait, #8a8f98)",
  stopAndError: "var(--node-error, #d6584f)",
  respondToWebhook: "var(--node-respond, #3f8fae)",
  code: "var(--node-code, #6f7a8f)",
  humanApproval: "var(--node-approval)",
  end: "var(--node-end)",
};
const LABEL = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.label]),
) as Record<NodeType, string>;

interface ViewData extends Record<string, unknown> {
  kind: NodeType;
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
        borderRadius: 10,
        border: `1px solid ${accent}`,
        background: "var(--card)",
        color: "var(--ink)",
        fontSize: 13,
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,.18)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: "9px 12px", fontWeight: 600 }}>
        {LABEL[data.kind]}
      </div>
      {data.subtitle && (
        <div
          className="mono"
          style={{ padding: "0 12px 9px", fontSize: 10, color: "var(--ink-3)" }}
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

function subtitleFor(
  kind: NodeType,
  config?: Record<string, unknown>,
): string | undefined {
  if (!config) return undefined;
  if (kind === "agent") return (config.model as string)?.replace("claude-", "");
  if (kind === "mcpTool") {
    const tool = config.tool as string | undefined;
    const conn = config.connectionId as string | undefined;
    return tool && conn ? `${conn} · ${tool}` : tool || conn;
  }
  return undefined;
}

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
          fontSize: 12.5,
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
          <div style={{ fontSize: 21, fontWeight: 700 }}>{g?.name ?? key}</div>
          <div
            className="mono"
            style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}
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
            fontSize: 12.5,
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
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
            How it runs
          </div>
          <p
            style={{
              fontSize: 12.5,
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
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink)",
              marginTop: 14,
            }}
          >
            Triggers
          </div>
          <ul
            style={{
              fontSize: 12.5,
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
                      <code key={u} style={{ fontSize: 11 }}>
                        POST {u}
                      </code>
                    ))}
                    <div
                      style={{
                        fontSize: 11.5,
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
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink)",
              marginTop: 14,
            }}
          >
            Error workflow
          </div>
          <p
            style={{
              fontSize: 12,
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
              borderRadius: 8,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: 12.5,
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
              fontSize: 12,
              fontWeight: 600,
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
                  fontSize: 10.5,
                  border: `1px solid ${ACCENT[n.type]}`,
                  color: ACCENT[n.type],
                  borderRadius: 6,
                  padding: "2px 8px",
                }}
              >
                {LABEL[n.type]}
              </span>
            ))}
          </div>
        </Card>
      </div>
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
      data: { kind: n.type, subtitle: subtitleFor(n.type, n.config) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: edgeLabel(e.condition),
    })),
  };
}
