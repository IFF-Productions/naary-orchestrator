import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button, Icon, Switch } from "../../components";
import {
  api,
  type GraphSummary,
  type RunSummary,
  UnauthorizedError,
} from "../../lib/api";
import { friendlyStep } from "../../lib/friendly-catalog";
import { ACCENT, nodeDisplayLabel } from "../../lib/graph-model";
import { orderedNodes } from "../../lib/graph-order";
import { fmtAge } from "../app/run-detail/run-view-model";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

const TRIGGER_TYPES = new Set<string>([
  "start",
  "webhookTrigger",
  "scheduleTrigger",
  "formTrigger",
  "chatTrigger",
  "errorTrigger",
  "pollTrigger",
]);

const nodeTint = (type: string): string =>
  ACCENT[type as keyof typeof ACCENT] ?? "var(--ink-3)";

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

/** A one-line, plain-language summary of what an automation does (from its real graph). */
function summarize(graph: GraphDef): string {
  const nodes = orderedNodes(graph);
  const entry = nodes[0];
  const entryIsTrigger = !!entry && TRIGGER_TYPES.has(entry.type);
  const trigger = entryIsTrigger
    ? (friendlyStep(entry.type)?.title ??
      nodeDisplayLabel(entry.type, entry.config))
    : "Runs manually";
  // Only drop the first node from the step count when it's an actual trigger — a
  // manual graph's first node IS a step (else a 1-step manual flow reads "0 steps").
  const rest = nodes.filter(
    (n) => n.type !== "end" && !(entryIsTrigger && n === entry),
  );
  const hasApproval = nodes.some((n) => n.type === "humanApproval");
  const stepWord = rest.length === 1 ? "step" : "steps";
  return `${trigger} · ${rest.length} ${stepWord}${hasApproval ? " · waits for your approval" : ""}`;
}

interface Enriched {
  summary: GraphSummary;
  graph: GraphDef | null;
  lastRunAt: string | null;
}

/** Simple-mode home (redesign 3a): each automation as a card — name, an On/Paused badge
 *  (paused ≠ failed), an on/off toggle wired to the REAL activate/pause action, a plain
 *  summary, a node-chain strip, and when it last ran. A Simple lens over the same graphs. */
export function Automations() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const [items, setItems] = useState<Enriched[] | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Keys with an activate/pause request in flight — one per automation at a time, so a
  // rapid double-tap can't race (the loser would revert on the winner's response).
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [summaries, runs, me] = await Promise.all([
          api.listGraphs(),
          api.listRuns().catch(() => [] as RunSummary[]),
          api.getMe().catch(() => null),
        ]);
        if (!live) return;
        if (me) setTenantId(me.tenantId);
        // Latest run timestamp per workflowKey (real "ran … ago").
        const lastRun = new Map<string, string>();
        for (const r of runs) {
          if (!r.workflowKey) continue;
          const prev = lastRun.get(r.workflowKey);
          if (!prev || new Date(r.createdAt) > new Date(prev)) {
            lastRun.set(r.workflowKey, r.createdAt);
          }
        }
        // Seed cards immediately; graphs (for the chain + summary) stream in after.
        setItems(
          summaries.map((s) => ({
            summary: s,
            graph: null,
            lastRunAt: lastRun.get(s.workflowKey) ?? null,
          })),
        );
        const graphs = await Promise.all(
          summaries.map((s) =>
            api
              .getGraph(s.workflowKey)
              .then((g) => g.graph)
              .catch(() => null),
          ),
        );
        if (!live) return;
        setItems(
          summaries.map((s, i) => ({
            summary: s,
            graph: graphs[i],
            lastRunAt: lastRun.get(s.workflowKey) ?? null,
          })),
        );
      } catch (e) {
        if (!live) return;
        setItems([]);
        setErr(
          e instanceof UnauthorizedError
            ? "Sign in to see your automations."
            : "Could not reach the server.",
        );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const runningCount = (items ?? []).filter((it) => it.summary.active).length;
  const pausedCount = (items ?? []).length - runningCount;

  function toggle(key: string, next: boolean) {
    if (!tenantId) {
      // The tenant hasn't resolved yet — say so instead of silently doing nothing.
      setErr("Still getting set up — try that again in a moment.");
      return;
    }
    if (inFlight.current.has(key)) return; // a request for this automation is already running
    inFlight.current.add(key);
    setErr(null);
    const flip = (val: boolean) =>
      setItems((prev) =>
        (prev ?? []).map((it) =>
          it.summary.workflowKey === key
            ? { ...it, summary: { ...it.summary, active: val } }
            : it,
        ),
      );
    // Optimistic flip; revert on failure (paused ≠ failed — this only stops auto-triggers).
    flip(next);
    api
      .setWorkflowActive(tenantId, key, next)
      .catch(() => {
        flip(!next);
        setErr(
          next
            ? "Couldn't turn that automation on — try again."
            : "Couldn't pause that automation — try again.",
        );
      })
      .finally(() => {
        inFlight.current.delete(key);
      });
  }

  return (
    <div
      style={{
        padding: phone ? "16px 16px 40px" : "22px 28px 40px",
        maxWidth: 760,
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
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Your automations
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            {items === null
              ? "Loading…"
              : `${runningCount} running · ${pausedCount} paused`}
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => navigate("/app/automations/new")}
        >
          New
        </Button>
      </div>

      {err && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      {items && items.length === 0 && !err && (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            background: "var(--card)",
            border: "1px dashed var(--line-2)",
            borderRadius: "var(--radius-lg)",
            color: "var(--ink-3)",
            fontSize: "var(--text-body)",
          }}
        >
          No automations yet.
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => navigate("/app/automations/new")}
            >
              Create your first
            </Button>
          </div>
        </div>
      )}

      {/* ===== Cards (flow responsively) ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 12,
        }}
      >
        {(items ?? []).map((it) => (
          <AutomationCard
            key={it.summary.workflowKey}
            item={it}
            onOpen={() =>
              navigate(
                `/app/automations/${encodeURIComponent(it.summary.workflowKey)}`,
              )
            }
            onToggle={(next) => toggle(it.summary.workflowKey, next)}
          />
        ))}
      </div>
    </div>
  );
}

function AutomationCard({
  item,
  onOpen,
  onToggle,
}: {
  item: Enriched;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
}) {
  const { summary, graph, lastRunAt } = item;
  const active = summary.active;
  const chain = graph ? orderedNodes(graph) : [];
  const ranAgo = lastRunAt
    ? `ran ${fmtAge(Date.now() - new Date(lastRunAt).getTime())} ago`
    : "never run";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxSizing: "border-box",
        padding: 16,
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        transition: "border-color .12s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--line-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--line)";
      }}
    >
      {/* Row 1: name + status badge + toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary.name}
        </span>
        <StatusBadge active={active} />
        {/* Toggle: real activate/pause. Wrapped to a ≥44px hit area; stops card-open. */}
        <span
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 44,
            minHeight: 44,
          }}
        >
          <Switch
            checked={active}
            onChange={onToggle}
            aria-label={active ? "Pause automation" : "Turn automation on"}
          />
        </span>
      </div>

      {/* Row 2: plain-language summary */}
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {graph ? summarize(graph) : " "}
      </div>

      {/* Row 3: node-chain strip */}
      {chain.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {chain.slice(0, 5).map((n, i) => (
            <span
              key={n.id}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              {i > 0 && (
                <span
                  style={{ color: "var(--ink-3)", fontSize: "var(--text-xs)" }}
                >
                  ›
                </span>
              )}
              <span
                title={nodeDisplayLabel(n.type, n.config)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: "var(--radius-sm)",
                  background: `color-mix(in srgb, ${nodeTint(n.type)} 16%, transparent)`,
                  color: nodeTint(n.type),
                }}
              >
                <Icon name={nodeIconFor(n.type)} size={12} />
              </span>
            </span>
          ))}
          {chain.length > 5 && (
            <span style={{ color: "var(--ink-3)", fontSize: "var(--text-xs)" }}>
              +{chain.length - 5}
            </span>
          )}
        </div>
      )}

      {/* Row 4: last run */}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
        {ranAgo}
      </div>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  const color = active ? "var(--state-done)" : "var(--state-paused)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
        }}
      />
      {active ? "On" : "Paused"}
    </span>
  );
}
