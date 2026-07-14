import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  GraphDef,
  RegionTrace,
  TraceCell,
  UnresolvedRef,
} from "@naary/dsl";
import {
  Button,
  Card,
  type Column,
  CodeBlock,
  Icon,
  LoadingBlock,
  StatusPill,
  Table,
} from "../../components";
import { RunDiagram } from "../../components/RunDiagram";
import {
  api,
  type ExecutionState,
  type RunEvent,
  UnauthorizedError,
} from "../../lib/api";
import { isTerminal, runStatusUi } from "../../lib/run-status";
import { RerunMenu, VersionBadge } from "./RerunMenu";

export function RunDetail() {
  const { id = "" } = useParams();
  return (
    <div style={{ padding: "20px 28px 40px" }}>
      <BackLink />
      <RunView id={id} />
    </div>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/app/runs")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: "none",
        color: "var(--ink-2)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        marginBottom: 14,
        padding: 0,
      }}
    >
      <Icon
        name="chevron-right"
        size={14}
        style={{ transform: "rotate(180deg)" }}
      />
      All runs
    </button>
  );
}

/* ---- Internal ctx keys are orchestrator bookkeeping, not node output. ---- */
function isNodeOutputKey(key: string): boolean {
  return !key.startsWith("__");
}

function formatCost(ctx: Record<string, unknown>): string {
  const c = ctx.__costUsd;
  return typeof c === "number" ? `$${c.toFixed(4)}` : "—";
}

/* ---- Items table (items-model A5) ----------------------------------------------
 * A node whose output is an array of objects — e.g. a Loop End's collected per-item
 * outputs, a Split Out source, or an Aggregate — reads far better as rows than as raw
 * JSON. This is pure presentation over ctx that already exists (loopEnd writes its
 * array to ctx[loopEndId] under the coexist model); it does NOT ask the engine to
 * persist any new per-item state. Anything that isn't an array-of-objects falls back
 * to JSON unchanged. */
const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 12;

function isItemsArray(v: unknown): v is Record<string, unknown>[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((el) => el !== null && typeof el === "object" && !Array.isArray(el))
  );
}

/** Union of keys across the (capped) rows, preserving first-seen order, capped to
 *  MAX_TABLE_COLS so a wide/ragged array can't explode the header. */
function itemsColumns(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    for (const k of Object.keys(row)) {
      if (!set.has(k)) {
        set.add(k);
        seen.push(k);
        if (seen.length >= MAX_TABLE_COLS) return seen;
      }
    }
  }
  return seen;
}

function cellText(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One node's output: an items table when it's an array of objects (with a JSON
 *  toggle), otherwise raw JSON exactly as before. */
function NodeOutputBody({ output }: { output: unknown }) {
  const [asJson, setAsJson] = useState(false);
  const tabular = isItemsArray(output);
  const rows = tabular ? (output as Record<string, unknown>[]) : [];
  const cols = tabular ? itemsColumns(rows) : [];
  const shown = rows.slice(0, MAX_TABLE_ROWS);

  const jsonBlock = (
    <CodeBlock
      style={{
        fontSize: "var(--text-2xs)",
        background: "var(--bg)",
        maxHeight: 320,
        overflow: "auto",
      }}
    >
      {JSON.stringify(output, null, 2)}
    </CodeBlock>
  );

  if (!tabular) return jsonBlock;

  // Row identity is the array index (rows can be structurally equal), so wrap each
  // row with its ordinal and key the table off that.
  const indexed = shown.map((row, i) => ({ i, row }));
  type Row = { i: number; row: Record<string, unknown> };
  const columns: Column<Row>[] = [
    { key: "__idx", header: "#", render: (r) => String(r.i + 1), width: 36 },
    ...cols.map((c) => ({
      key: c,
      header: c,
      render: (r: Row) => (
        <span className="mono" style={{ fontSize: "var(--text-2xs)" }}>
          {cellText(r.row[c])}
        </span>
      ),
    })),
  ];

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <StatusPill state="done" label={`${rows.length} items`} />
        <button
          type="button"
          onClick={() => setAsJson((v) => !v)}
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            background: "none",
            border: "none",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {asJson ? "view as table" : "view as JSON"}
        </button>
      </div>
      {asJson ? (
        jsonBlock
      ) : (
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          <Table columns={columns} rows={indexed} rowKey={(r) => String(r.i)} />
          {rows.length > MAX_TABLE_ROWS && (
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
                marginTop: 6,
              }}
            >
              +{rows.length - MAX_TABLE_ROWS} more rows — switch to JSON to see
              all.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ---- Per-item trace grid (items-model A5 §0.4.2) --------------------------------
 * The worker publishes `ctx.__regionTrace` keyed by splitOut: each entry is either a grid
 * ({ nodes, items, truncatedItems? }) with tri-state cells (value / dead branch / error), or an
 * `{ unavailable }` marker — "batched" for A3 node-major regions, "budget" when the aggregate trace
 * byte cap was hit first. The collected-array table above still shows those regions' results.
 * TraceCell / RegionTrace are the shared wire types from @naary/dsl (the worker writes them). */
function TraceCellView({ cell }: { cell: TraceCell | undefined }) {
  if (!cell) return <span style={{ color: "var(--ink-3)" }}>—</span>;
  if ("dead" in cell)
    return (
      <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>dead</span>
    );
  if ("err" in cell)
    return (
      <span className="mono" style={{ color: "var(--state-error)" }}>
        {cell.err}
      </span>
    );
  return (
    <span className="mono" style={{ fontSize: "var(--text-2xs)" }}>
      {cellText(cell.v)}
    </span>
  );
}

function RegionTraceSection({ ctx }: { ctx: Record<string, unknown> }) {
  const raw = ctx.__regionTrace;
  if (raw === null || typeof raw !== "object") return null;
  const regions = Object.entries(raw as Record<string, RegionTrace>);
  if (regions.length === 0) return null;

  return (
    <Card style={{ padding: "18px 20px", marginTop: 16 }}>
      <SectionTitle>Per-item trace</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {regions.map(([splitId, trace]) => {
          if ("unavailable" in trace) {
            return (
              <div key={splitId}>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  {splitId}
                </span>
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 4,
                  }}
                >
                  {trace.unavailable === "budget"
                    ? "Per-item trace omitted — this run's trace exceeded the size budget."
                    : "Per-item trace unavailable for batched-activity regions —"}{" "}
                  see the collected array in <strong>Node outputs</strong>{" "}
                  above.
                </div>
              </div>
            );
          }
          const rows = trace.items.map((cells, i) => ({ i, cells }));
          type TraceRow = { i: number; cells: Record<string, TraceCell> };
          const columns: Column<TraceRow>[] = [
            {
              key: "__idx",
              header: "#",
              render: (r) => String(r.i + 1),
              width: 36,
            },
            ...trace.nodes.map((nid) => ({
              key: nid,
              header: nid,
              render: (r: TraceRow) => <TraceCellView cell={r.cells[nid]} />,
            })),
          ];
          return (
            <div key={splitId}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  {splitId}
                </span>
                <StatusPill
                  state="done"
                  label={`${trace.items.length} items`}
                />
              </div>
              <div style={{ maxHeight: 360, overflow: "auto" }}>
                <Table
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => String(r.i)}
                />
              </div>
              {trace.truncatedItems ? (
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 6,
                  }}
                >
                  trace truncated — {trace.truncatedItems} more item
                  {trace.truncatedItems === 1 ? "" : "s"} ran but were not
                  captured (cap {MAX_TABLE_ROWS}).
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---- Unresolved inputs (which source produced no output) ------------------------
 * The worker writes `ctx.__unresolved` (keyed by node id) when a node's input reference — a
 * `{{ source.path }}` token OR a `{from,path}` binding — resolved to nothing because its SOURCE
 * produced no output. This is the "the run looked complete but a node silently got empty input"
 * diagnostic: it names exactly which node, which field, and which source was missing. */
function unresolvedRefs(ctx: Record<string, unknown>): UnresolvedRef[] {
  const raw = ctx.__unresolved;
  if (raw === null || typeof raw !== "object") return [];
  return Object.values(raw as Record<string, UnresolvedRef[]>)
    .flat()
    .filter((r): r is UnresolvedRef => !!r && typeof r === "object");
}

function UnresolvedInputsSection({ ctx }: { ctx: Record<string, unknown> }) {
  const refs = unresolvedRefs(ctx);
  if (refs.length === 0) return null;
  return (
    <Card
      style={{
        padding: "16px 20px",
        marginBottom: 16,
        borderColor: "color-mix(in srgb, var(--state-paused) 45%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <Icon name="alert" size={16} style={{ color: "var(--state-paused)" }} />
        <span
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          Unresolved inputs
        </span>
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        These inputs read from a source that produced no output, so the node ran
        with them empty — a likely cause of a node that looks fine but did
        nothing.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {refs.map((r, i) => (
          <div
            key={`${r.nodeId}.${r.field}.${i}`}
            style={{ fontSize: "var(--text-sm)", color: "var(--ink-1)" }}
          >
            <span
              className="mono"
              style={{ fontWeight: "var(--weight-semibold)" }}
            >
              {r.nodeId}
            </span>{" "}
            · field <span className="mono">{r.field}</span> reads{" "}
            <span className="mono">{r.ref}</span> —{" "}
            <span style={{ color: "var(--ink-2)" }}>
              {r.sourceExists
                ? `"${r.from}" ran but produced no output on this branch`
                : `no node "${r.from}" — check the source id`}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------- Real run: polls the control plane for live + closed runs ------------- */
function RunView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<ExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The graph SNAPSHOT this run executed (immutable → fetched once). null while loading or if
  // the snapshot is unavailable (older runs) — the canvas section just doesn't render then.
  const [graph, setGraph] = useState<GraphDef | null>(null);
  // The executed graph's version + the run's workflowKey (for the re-run-at-version picker),
  // fetched alongside the snapshot. null until loaded / for pre-snapshot runs.
  const [runVersion, setRunVersion] = useState<number | null>(null);
  const [runWorkflowKey, setRunWorkflowKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const next = await api.getState(id);
      setState(next);
      setError(null);
      return next;
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — set your API token on the sign-in screen."
          : "Could not reach the control plane (apps/api on :3000).",
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Fetch the run's executed graph snapshot once (immutable for the life of the run).
  useEffect(() => {
    let cancelled = false;
    // Clear the previous run's graph immediately so navigating between runs (this screen
    // isn't unmounted) never flashes — or keeps showing — the wrong run's canvas.
    setGraph(null);
    setRunVersion(null);
    setRunWorkflowKey(null);
    api.getRunGraph(id).then(
      (r) => {
        if (!cancelled) {
          setGraph(r.graph);
          setRunVersion(r.version);
          setRunWorkflowKey(r.workflowKey);
        }
      },
      (e) => {
        // A 404 is expected for pre-snapshot runs — skip the canvas silently. Anything else
        // (500, auth/routing) is unexpected: log it so a real failure is detectable, not hidden.
        if (!(e instanceof Error) || !/→ 404$/.test(e.message)) {
          console.warn("run-detail canvas: graph fetch failed", e);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Poll until the run reaches a terminal status (then stop — closed runs don't change).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await poll();
      if (cancelled) return;
      if (!next || !isTerminal(next.status)) {
        timer.current = setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  // Fetch the signed resume URL while the run is paused on a wait(webhook) node. Built like the
  // webhook ingress URLs elsewhere: `${origin}/api` + the relative path the API returns.
  useEffect(() => {
    if (state?.status !== "awaiting_webhook") {
      setResumeUrl(null);
      return;
    }
    let cancelled = false;
    api.getResumeUrl(id).then(
      (r) => {
        if (!cancelled) setResumeUrl(`${window.location.origin}/api${r.path}`);
      },
      () => {
        /* transient — the poll will retry via a re-render */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state?.status, id]);

  async function decide(approved: boolean) {
    setActing(true);
    try {
      await api.approve(id, approved);
      await poll();
    } catch {
      setError("Approval signal failed.");
    } finally {
      setActing(false);
    }
  }

  async function cancelRun() {
    if (
      !window.confirm(
        "Cancel this run? It will be terminated and can't resume.",
      )
    )
      return;
    setActing(true);
    try {
      await api.cancelRun(id);
      await poll();
    } catch {
      setError("Could not cancel the run (it may have already finished).");
    } finally {
      setActing(false);
    }
  }

  const status = state?.status;
  const awaiting = status === "awaiting_approval";
  const awaitingWebhook = status === "awaiting_webhook";
  const running = status === "running";
  const ui = status ? runStatusUi(status) : null;

  const nodeOutputs = state
    ? Object.entries(state.ctx).filter(([k]) => isNodeOutputKey(k))
    : [];

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 42,
              height: 42,
              borderRadius: "var(--radius-lg)",
              background: "var(--brand-soft)",
              border:
                "1px solid color-mix(in srgb, var(--brand) 40%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
              color: "var(--brand)",
            }}
          >
            <Icon name="bolt" size={20} />
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  fontSize: "var(--text-title)",
                  fontWeight: "var(--weight-bold)",
                }}
              >
                Execution
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-2)",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  padding: "2px 8px",
                  borderRadius: "var(--radius-xs)",
                }}
              >
                {id}
              </span>
              {ui && <StatusPill state={ui.state} label={ui.label} />}
            </div>
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
                marginTop: 4,
              }}
            >
              {running || awaiting || awaitingWebhook
                ? "Polling GET /executions/:id every 1.5s"
                : "Final state · GET /executions/:id"}
            </div>
          </div>
        </div>
        {(awaiting || running || awaitingWebhook) && (
          <div style={{ display: "flex", gap: 8 }}>
            {awaiting && (
              <>
                <Button
                  variant="positive"
                  icon="check"
                  disabled={acting}
                  onClick={() => decide(true)}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={acting}
                  onClick={() => decide(false)}
                >
                  Reject
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              icon="x"
              disabled={acting}
              onClick={cancelRun}
            >
              Cancel run
            </Button>
          </div>
        )}
        {status && isTerminal(status) && (
          <RerunMenu
            runId={id}
            workflowKey={runWorkflowKey}
            currentVersion={runVersion}
            size="md"
            label="Re-run"
            onRerun={(newId) => navigate(`/app/runs/${newId}`)}
            onError={setError}
          />
        )}
      </div>

      {error && (
        <Card
          style={{
            borderColor:
              "color-mix(in srgb, var(--state-error) 40%, transparent)",
          }}
        >
          <span
            style={{
              color: "var(--state-error)",
              fontSize: "var(--text-body)",
            }}
          >
            {error}
          </span>
        </Card>
      )}

      {awaitingWebhook && (
        <Card
          style={{
            borderColor: "color-mix(in srgb, var(--brand) 40%, transparent)",
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="bolt" size={16} />
            <span
              style={{
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-bold)",
              }}
            >
              Waiting for a webhook
            </span>
          </div>
          <p
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              margin: "8px 0 12px",
            }}
          >
            This run is paused until an external system POSTs to its resume URL.
            The URL contains a signed token — anyone with it can resume the run,
            so treat it like a secret.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code
              className="mono"
              style={{
                flex: 1,
                overflowX: "auto",
                whiteSpace: "nowrap",
                fontSize: "var(--text-xs)",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-xs)",
                padding: "8px 10px",
                color: "var(--ink-1)",
              }}
            >
              {resumeUrl ?? "Loading resume URL…"}
            </code>
            <Button
              variant="secondary"
              icon={copied ? "check" : "copy"}
              disabled={!resumeUrl}
              onClick={() => {
                if (!resumeUrl) return;
                void navigator.clipboard?.writeText(resumeUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {!error && loading && !state && (
        <Card>
          <LoadingBlock label="Loading run…" />
        </Card>
      )}

      {/* Workflow canvas — the graph this run executed, with the path it took highlighted.
          Green = ran, ember/amber = the current step, dim = not reached. */}
      {!error && state && graph && (
        <Card style={{ padding: "16px 18px 14px", marginBottom: 16 }}>
          <SectionTitle>Workflow canvas</SectionTitle>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            The graph this run executed — green nodes ran; the highlighted node
            is the current step; dimmed nodes weren't reached.
          </div>
          <RunDiagram
            graph={graph}
            ctx={state.ctx}
            currentNodeId={state.currentNodeId}
            status={state.status}
          />
        </Card>
      )}

      {/* Run input — the payload that STARTED the run (webhook event, form submission,
          or manual input), held in ctx.__input. Hidden from Node outputs (which drops __*). */}
      {!error && state && state.ctx.__input !== undefined && (
        <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
          <SectionTitle>Run input</SectionTitle>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginBottom: 8,
            }}
          >
            The payload that started this run (trigger event / manual input).
          </div>
          <NodeOutputBody output={state.ctx.__input} />
        </Card>
      )}

      {!error && state && <UnresolvedInputsSection ctx={state.ctx} />}

      {!error && state && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}
        >
          {/* Node outputs — the real "what each node produced" view. */}
          <Card style={{ padding: "18px 20px" }}>
            <SectionTitle>Node outputs</SectionTitle>
            {nodeOutputs.length === 0 ? (
              <div
                style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}
              >
                No node outputs yet — this run hasn't produced any node results.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                {nodeOutputs.map(([nodeId, output]) => (
                  <div key={nodeId}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 6,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--text-sm)",
                          fontWeight: "var(--weight-semibold)",
                        }}
                      >
                        {nodeId}
                      </span>
                      {running && state.currentNodeId === nodeId && (
                        <StatusPill state="running" label="current" />
                      )}
                    </div>
                    <NodeOutputBody output={output} />
                  </div>
                ))}
              </div>
            )}
            <div
              className="mono"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid var(--line)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
              }}
            >
              live node outputs (ctx) · full event history below
            </div>
          </Card>

          {/* Run summary */}
          <Card>
            <SectionTitle>Run summary</SectionTitle>
            <SummaryRow label="Status">
              {ui ? <StatusPill state={ui.state} label={ui.label} /> : "—"}
            </SummaryRow>
            <SummaryRow label="Graph version">
              <VersionBadge version={runVersion} />
            </SummaryRow>
            {running && (
              <SummaryRow label="Current node">
                <span className="mono" style={{ fontSize: "var(--text-body)" }}>
                  {state.currentNodeId || "—"}
                </span>
              </SummaryRow>
            )}
            <SummaryRow label="Accumulated cost">
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--state-done)",
                }}
              >
                {formatCost(state.ctx)}
              </span>
            </SummaryRow>
            <div
              style={{
                marginTop: 14,
                paddingTop: 13,
                borderTop: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--state-done)",
                }}
              />
              <span
                className="mono"
                style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
              >
                durable · state checkpointed · resumable for 30d
              </span>
            </div>
          </Card>
        </div>
      )}

      {!error && state && <RegionTraceSection ctx={state.ctx} />}
      {!error && state && <RunLog id={id} />}
    </>
  );
}

/* ---- Execution log: the run's curated Temporal history (durable record). ---- */
const LOG_KIND_COLOR: Record<string, string> = {
  started: "var(--state-info)",
  activity: "var(--node-agent)",
  signal: "var(--node-approval)",
  timer: "var(--state-paused)",
  completed: "var(--state-done)",
  error: "var(--state-error)",
  continued: "var(--ink-3)",
};

function RunLog({ id }: { id: string }) {
  const [events, setEvents] = useState<Awaited<
    ReturnType<typeof api.getRunHistory>
  > | null>(null);

  // Poll the history until a terminal event appears — the closing event can lag
  // the status flip, so a single fetch can miss it.
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const done = (evs: RunEvent[]) =>
      evs.some((e) => ["completed", "error", "continued"].includes(e.kind));
    const tick = async () => {
      try {
        const e = await api.getRunHistory(id);
        if (!live) return;
        setEvents(e);
        if (!done(e)) t = setTimeout(tick, 2000);
      } catch {
        if (live) t = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id]);

  return (
    <Card style={{ padding: "18px 20px", marginTop: 16 }}>
      <SectionTitle>Execution log</SectionTitle>
      {!events ? (
        <LoadingBlock label="Loading log…" />
      ) : events.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
          No events yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {events.map((ev) => (
            <div
              key={ev.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "6px 0",
                borderTop: "1px solid var(--line)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "none",
                  marginTop: 5,
                  background: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-3)",
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: "var(--text-body)",
                  color: "var(--ink)",
                }}
              >
                {ev.label}
                {ev.detail && (
                  <span
                    className="mono"
                    style={{
                      color: "var(--ink-3)",
                      marginLeft: 8,
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {ev.detail}
                  </span>
                )}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                  flex: "none",
                }}
              >
                {ev.at ? new Date(ev.at).toLocaleTimeString() : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-md)",
        fontWeight: "var(--weight-semibold)",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 11,
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}
