import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Spinner,
  StatusPill,
  Table,
  Tabs,
} from "../../../components";
import {
  api,
  type CompanyWorkspaceRuns,
  type CompanyWorkspaceWorkflow,
} from "../../../lib/api";
import { runStatusUi } from "../../../lib/run-status";
import { workspaceLabel } from "../../../workspace/WorkspaceSwitcher";
import type { Drill, DrillTab } from "./types";

/** READ-ONLY drill-down into one member workspace — summaries only, rows are not links
 *  (run detail is workspace-gated; a non-member admin has no route to it by design). */
export function DrillPanel({
  companyId,
  drill,
  setTab,
  onClose,
}: {
  companyId: string;
  drill: Drill;
  setTab: (t: DrillTab) => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<CompanyWorkspaceRuns | null>(null);
  const [flows, setFlows] = useState<CompanyWorkspaceWorkflow[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setFlows(null);
    if (drill.tab === "runs") {
      api
        .listCompanyWorkspaceRuns(companyId, drill.tenantId, { limit: 25 })
        .then((r) => live && setRuns(r))
        .catch(() => live && setRuns({ items: [], nextCursor: null }));
    } else {
      api
        .listCompanyWorkspaceWorkflows(companyId, drill.tenantId)
        .then((f) => live && setFlows(f))
        .catch(() => live && setFlows([]));
    }
    return () => {
      live = false;
    };
  }, [companyId, drill.tenantId, drill.tab]);

  async function loadMore() {
    if (!runs?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listCompanyWorkspaceRuns(
        companyId,
        drill.tenantId,
        {
          limit: 25,
          cursor: runs.nextCursor,
        },
      );
      // Functional update: if the drill target/tab changed mid-flight the effect above reset
      // `runs` to null — appending the captured page here would resurrect stale rows.
      setRuns((cur) =>
        cur === null
          ? cur
          : {
              items: [...cur.items, ...next.items],
              nextCursor: next.nextCursor,
            },
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: "var(--weight-semibold)" }}>
          {workspaceLabel(drill.tenantId, drill.displayName ?? undefined)}
        </div>
        <Tabs<DrillTab>
          tabs={[
            { value: "runs", label: "Runs" },
            { value: "workflows", label: "Workflows" },
          ]}
          active={drill.tab}
          onChange={setTab}
        />
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {/* Observer boundary: run detail + graph bodies stay workspace-gated (§7.3). */}
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
        Read-only — you observe this workspace's activity, you don't edit it.
      </div>
      {drill.tab === "runs" ? (
        runs === null ? (
          <Spinner />
        ) : (
          <>
            <Table
              columns={[
                {
                  key: "wf",
                  header: "Workflow",
                  render: (r: CompanyWorkspaceRuns["items"][number]) =>
                    r.workflowKey ?? "—",
                },
                {
                  key: "status",
                  header: "Status",
                  // runStatusUi keeps the differentiators legible: paused (awaiting_budget /
                  // awaiting_approval) reads amber, NOT the red of a failure, and approvals-
                  // waiting are visible as their own paused state — all from real run status.
                  render: (r) => {
                    const ui = runStatusUi(r.status);
                    return <StatusPill state={ui.state} label={ui.label} />;
                  },
                },
                {
                  key: "created",
                  header: "Started",
                  render: (r) => new Date(r.createdAt).toLocaleString(),
                },
              ]}
              rows={runs.items}
              rowKey={(r) => r.workflowId}
            />
            {runs.nextCursor && (
              <div style={{ marginTop: 10 }}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadingMore}
                  onClick={loadMore}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )
      ) : flows === null ? (
        <Spinner />
      ) : (
        <Table
          columns={[
            {
              key: "name",
              header: "Workflow",
              render: (f: CompanyWorkspaceWorkflow) => f.name,
            },
            { key: "key", header: "Key", render: (f) => f.workflowKey },
            { key: "v", header: "Version", render: (f) => `v${f.version}` },
            {
              key: "updated",
              header: "Updated",
              render: (f) => new Date(f.updatedAt).toLocaleDateString(),
            },
          ]}
          rows={flows}
          rowKey={(f) => f.workflowKey}
        />
      )}
    </Card>
  );
}
