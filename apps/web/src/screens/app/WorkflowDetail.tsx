/**
 * Workflow detail (redesign "Naary Workflows.dc.html") — trigger + activation
 * surfaced up top, environments + promote folded in, version history with
 * live-env badges, recent runs, and the read-only graph preview.
 *
 * Data honesty: the trigger comes from the graph's entry node; env tiles /
 * drift / badges come from per-env graph + version data (content-hash
 * comparison); "who" is only shown where the backend records it (promotion
 * lineage); there is no stored description, so the sub-line is derived from
 * real facts (trigger · node count · version).
 */
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
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCanvasLink } from "../../lib/useCanvasLink";
import type { GraphDef, NodeType } from "@naary/dsl";
import { Button, Card, Icon, Toast, useConfirm } from "../../components";
import {
  api,
  type GraphVersion,
  type NamedGraph,
  type RunSummary,
  UnauthorizedError,
  type WebhookRow,
} from "../../lib/api";
import { decompileGraph } from "../../lib/decompile-graph";
import { ACCENT, nodeDisplayLabel, nodeSubtitle } from "../../lib/graph-model";
import { canDo } from "../../lib/permissions-logic";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePermissions } from "../../lib/usePermissions";
import { DiffModal, type DiffPreset } from "./workflows/DiffModal";
import { EnvironmentsCard } from "./workflows/EnvironmentsCard";
import { RecentRunsCard, VersionHistoryCard } from "./workflows/HistoryCards";
import { envRank, triggerInfo, useEnvOverview } from "./workflows/model";
import { PromoteConfirmDialog } from "./workflows/PromoteConfirmDialog";

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
  const confirm = useConfirm();
  const { key = "" } = useParams();
  const navigate = useNavigate();
  // Canvas links carry ?from= so the canvas's back control returns HERE.
  const canvasLink = useCanvasLink();
  const phone = useMediaQuery(PHONE_QUERY);
  const perms = usePermissions();
  const [g, setG] = useState<NamedGraph | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<{ workflowKey: string }[]>([]);
  const [errWk, setErrWk] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // ACTIVE-env version history (the diff pickers + the history card).
  const [versions, setVersions] = useState<GraphVersion[]>([]);
  const { overview, reload: reloadOverview } = useEnvOverview(key);
  // Promote/diff target (a non-active env) — defaults to the highest-ranked one.
  const [targetEnvId, setTargetEnvId] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState<{
    preset: DiffPreset | null;
    note?: string;
    withPromote: boolean;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(text: string): void {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

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
      .listGraphVersions(key)
      .then((vs) => live && setVersions(vs))
      .catch(() => undefined);
    api
      .listRuns()
      .then((rs) => live && setRuns(rs.filter((r) => r.workflowKey === key)))
      .catch(() => undefined);
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

  // Default promote target: the highest-ranked env that isn't the active one.
  useEffect(() => {
    if (!overview || targetEnvId) return;
    const candidates = overview.envs
      .filter((s) => s.env.id !== overview.activeEnv?.id)
      .sort((a, b) => envRank(b.env) - envRank(a.env));
    if (candidates[0]) setTargetEnvId(candidates[0].env.id);
  }, [overview, targetEnvId]);

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
  const trigger = g ? triggerInfo(g.graph) : null;

  const mayPromote = canDo(perms, "share", key);
  const mayDelete = canDo(perms, "delete", key);

  const activeEnv = overview?.activeEnv ?? null;
  const activeSlot =
    overview?.envs.find((s) => s.env.id === activeEnv?.id) ?? null;
  const targetSlot =
    overview?.envs.find((s) => s.env.id === targetEnvId) ?? null;

  /** Cross-env diff: resolve the target's latest CONTENT to a version in the
   *  active env's history; if found, diff that version → the active latest
   *  (exactly what a promote would apply to the target). */
  function openCrossEnvDiff(): void {
    if (!activeEnv || !targetSlot || versions.length === 0) {
      setDiffOpen({ preset: null, withPromote: mayPromote });
      return;
    }
    const targetHash = targetSlot.versions[0]?.contentHash;
    const idx = targetHash
      ? versions.findIndex((v) => v.contentHash === targetHash)
      : -1;
    if (idx >= 0) {
      const tv = targetSlot.summary?.version;
      setDiffOpen({
        preset: {
          from: versions[idx].version,
          to: versions[0].version,
          title: `${targetSlot.env.name}${tv != null ? ` v${tv}` : ""} → ${activeEnv.name} v${versions[0].version} · what promote applies`,
        },
        withPromote: mayPromote,
      });
    } else {
      setDiffOpen({
        preset: null,
        note: targetHash
          ? `${targetSlot.env.name}'s current content isn't in ${activeEnv.name}'s history — comparing ${activeEnv.name} versions instead.`
          : `This workflow isn't deployed in ${targetSlot.env.name} yet — promote will make its first deploy.`,
        withPromote: mayPromote,
      });
    }
  }

  async function doPromote(): Promise<void> {
    if (!targetSlot || promoteBusy) return;
    setPromoteBusy(true);
    try {
      const res = await api.promoteWorkflow(key, targetSlot.env.slug);
      setConfirmOpen(false);
      showToast(`Promoted to ${targetSlot.env.name} (v${res.toVersion})`);
      reloadOverview();
    } catch {
      showToast(`Could not promote to ${targetSlot.env.name}.`);
    } finally {
      setPromoteBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (deleting || !g) return;
    const ok = await confirm({
      title: `Delete workflow "${g.name}"?`,
      body: "This removes the workflow and its webhooks, forms, chats, and schedules. Run history is kept. This can't be undone.",
      confirmLabel: "Delete workflow",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.deleteGraph(key);
      navigate("/app/workflows");
    } catch {
      setError("Could not delete the workflow — try again.");
      setDeleting(false);
    }
  }

  async function run(): Promise<void> {
    try {
      const { workflowId } = await api.startExecution(key);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch {
      setError("Could not start a run.");
    }
  }

  return (
    <div
      style={{
        padding: phone ? "16px 14px 32px" : "22px 28px 40px",
        maxWidth: 1120,
        margin: "0 auto",
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <button
        type="button"
        onClick={() => navigate("/app/workflows")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--ink-2)",
          fontSize: "var(--text-sm)",
          padding: 0,
          marginBottom: 16,
        }}
      >
        <Icon name="arrow-left" size={13} />
        All workflows
      </button>

      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 15,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            flex: "none",
            borderRadius: 12,
            border: `1px solid ${trigger?.accent ?? "var(--line-2)"}`,
            color: trigger?.accent ?? "var(--ink-3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={trigger?.icon ?? "workflow"} size={22} />
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
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
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 3,
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span className="mono" style={{ color: "var(--ink-3)" }}>
              {key}
              {g ? ` · v${g.version}` : ""}
            </span>
            {trigger && (
              <span>
                · {trigger.label} trigger · {g?.graph.nodes.length} nodes
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <Button icon="play" onClick={run}>
            Run now
          </Button>
          <Button
            variant="secondary"
            icon="edit"
            onClick={() =>
              navigate(canvasLink(`/app/canvas?key=${encodeURIComponent(key)}`))
            }
          >
            Edit in canvas
          </Button>
          {mayDelete && (
            <Button
              variant="secondary"
              icon="trash"
              loading={deleting}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          )}
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

      {/* environments + promote (only when the env picture loaded) */}
      {overview && overview.envs.length > 0 && (
        <EnvironmentsCard
          overview={overview}
          target={targetSlot?.env ?? null}
          onTargetChange={setTargetEnvId}
          mayPromote={mayPromote}
          onViewDiff={openCrossEnvDiff}
          onPromote={() => setConfirmOpen(true)}
        />
      )}

      {/* versions + recent runs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: phone ? "1fr" : "1.3fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <VersionHistoryCard
          versions={versions}
          overview={overview}
          onCompare={() => setDiffOpen({ preset: null, withPromote: false })}
        />
        <RecentRunsCard runs={runs.slice(0, 8)} />
      </div>

      {/* the decision tree + how it runs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: phone ? "1fr" : "1.7fr 1fr",
          gap: 16,
        }}
      >
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

      {/* diff modal (cross-env preset or manual pickers) */}
      <DiffModal
        workflowKey={key}
        open={!!diffOpen}
        onClose={() => setDiffOpen(null)}
        versions={versions}
        preset={diffOpen?.preset ?? null}
        note={diffOpen?.note}
        promoteCta={
          diffOpen?.withPromote && targetSlot
            ? {
                label: `Promote to ${targetSlot.env.name}`,
                onClick: () => {
                  setDiffOpen(null);
                  setConfirmOpen(true);
                },
              }
            : null
        }
      />

      {/* promote confirm */}
      <PromoteConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void doPromote()}
        busy={promoteBusy}
        source={
          activeEnv && activeSlot?.summary
            ? { env: activeEnv, version: activeSlot.summary.version }
            : activeEnv && g
              ? { env: activeEnv, version: g.version }
              : null
        }
        target={targetSlot?.env ?? null}
        targetVersion={targetSlot?.summary?.version ?? null}
      />

      {/* toast (bottom-right, auto-dismiss) */}
      {toast && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 22,
            zIndex: 120,
          }}
        >
          <Toast kind="done" onDismiss={() => setToast(null)}>
            {toast}
          </Toast>
        </div>
      )}
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
