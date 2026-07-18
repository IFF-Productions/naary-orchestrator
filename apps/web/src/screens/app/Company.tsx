// Company console (COMPANIES.md §7.3): a company admin's cross-workspace view — usage rollup
// + READ-ONLY drill-down into each member workspace's runs/workflows. All reads go through the
// company-authz path (§4); run detail stays workspace-gated, so drill-down rows are not links.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Spinner,
  StatCard,
  Table,
  Tabs,
  TextInput,
} from "../../components";
import {
  api,
  type Company,
  type CompanyUsage,
  type CompanyWorkspaceRuns,
  type CompanyWorkspaceWorkflow,
} from "../../lib/api";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { workspaceLabel } from "../../workspace/WorkspaceSwitcher";
import { usd } from "./insights.logic";

type DrillTab = "runs" | "workflows";

interface Drill {
  tenantId: string;
  displayName: string | null;
  tab: DrillTab;
}

export function Company() {
  const navigate = useNavigate();
  const { workspaces, setActive } = useWorkspace();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<CompanyUsage | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reloadCompanies = useCallback(async () => {
    const list = await api.getMyCompanies();
    setCompanies(list);
    setCompanyId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    reloadCompanies().catch(() =>
      setErr("Couldn't load your companies. Reload to retry."),
    );
  }, [reloadCompanies]);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setUsage(null);
    setDrill(null);
    api
      .getCompanyUsage(companyId)
      .then((u) => live && setUsage(u))
      .catch(() => live && setErr("Couldn't load the company usage rollup."));
    return () => {
      live = false;
    };
  }, [companyId]);

  async function createCompany() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await api.createCompany(newName.trim());
      setCreateOpen(false);
      setNewName("");
      await reloadCompanies();
      setCompanyId(c.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the company.");
    } finally {
      setBusy(false);
    }
  }

  if (companies === null) {
    return (
      <div style={{ padding: "22px 28px" }}>
        <Spinner />
      </div>
    );
  }

  if (companies.length === 0) {
    return (
      <div style={{ padding: "22px 28px 40px", maxWidth: 720 }}>
        <EmptyState
          icon="users"
          title="No company yet"
          body="A company groups your workspaces for cross-workspace billing and admin visibility. Create one, then attach workspaces you own."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create company
            </Button>
          }
        />
        <CreateCompanyDialog
          open={createOpen}
          busy={busy}
          name={newName}
          setName={setNewName}
          onClose={() => setCreateOpen(false)}
          onCreate={createCompany}
        />
        {err && <ErrorLine text={err} />}
      </div>
    );
  }

  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const memberTenantIds = new Set(workspaces.map((w) => w.tenantId));

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {companies.length > 1 && (
          <select
            value={company.id}
            onChange={(e) => setCompanyId(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: "var(--radius-md)" }}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          New company
        </Button>
        <AttachCurrentWorkspace
          companyId={company.id}
          onAttached={() => setCompanyId((id) => id)}
          reload={() => api.getCompanyUsage(company.id).then(setUsage)}
        />
      </div>

      {err && <ErrorLine text={err} />}

      {usage === null ? (
        <Spinner />
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <StatCard
              label="Company spend (30d)"
              value={usd(usage.totals.costUsd)}
            />
            <StatCard
              label="Tokens"
              value={usage.totals.totalTokens.toLocaleString()}
            />
            <StatCard
              label="Metered calls"
              value={String(usage.totals.calls)}
            />
          </div>

          <Card>
            <Table
              columns={[
                {
                  key: "name",
                  header: "Workspace",
                  render: (w: CompanyUsage["byWorkspace"][number]) =>
                    workspaceLabel(w.tenantId, w.displayName ?? undefined),
                },
                {
                  key: "spend",
                  header: "Spend",
                  render: (w) => usd(w.costUsd),
                },
                {
                  key: "tokens",
                  header: "Tokens",
                  render: (w) => w.totalTokens.toLocaleString(),
                },
                {
                  key: "calls",
                  header: "Calls",
                  render: (w) => String(w.calls),
                },
                {
                  key: "actions",
                  header: "",
                  render: (w) => (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDrill({
                            tenantId: w.tenantId,
                            displayName: w.displayName,
                            tab: "runs",
                          })
                        }
                      >
                        Runs
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDrill({
                            tenantId: w.tenantId,
                            displayName: w.displayName,
                            tab: "workflows",
                          })
                        }
                      >
                        Workflows
                      </Button>
                      {memberTenantIds.has(w.tenantId) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setActive(w.tenantId);
                            navigate("/app/runs");
                          }}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
              rows={usage.byWorkspace}
              rowKey={(w) => w.tenantId}
            />
          </Card>

          {drill && (
            <DrillPanel
              companyId={company.id}
              drill={drill}
              setTab={(tab) => setDrill({ ...drill, tab })}
              onClose={() => setDrill(null)}
            />
          )}
        </>
      )}

      <CreateCompanyDialog
        open={createOpen}
        busy={busy}
        name={newName}
        setName={setNewName}
        onClose={() => setCreateOpen(false)}
        onCreate={createCompany}
      />
    </div>
  );
}

/** READ-ONLY drill-down into one member workspace — summaries only, rows are not links
 *  (run detail is workspace-gated; a non-member admin has no route to it by design). */
function DrillPanel({
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
          marginBottom: 12,
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
                { key: "status", header: "Status", render: (r) => r.status },
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

/** Attach the ACTIVE workspace (server enforces the §4 owner-authorized invariant). */
function AttachCurrentWorkspace({
  companyId,
  reload,
}: {
  companyId: string;
  onAttached?: () => void;
  reload: () => Promise<unknown>;
}) {
  const { activeId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!activeId) return null;
  return (
    <>
      <Button
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            await api.attachWorkspaceToCompany(companyId, activeId);
            await reload();
          } catch {
            setMsg(
              "Couldn't attach — you must own the active workspace, and it can't already belong to another company.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Attach current workspace
      </Button>
      {msg && <ErrorLine text={msg} />}
    </>
  );
}

function CreateCompanyDialog({
  open,
  busy,
  name,
  setName,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  name: string;
  setName: (v: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a company"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={onCreate}
          >
            Create
          </Button>
        </>
      }
    >
      <TextInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Acme Inc."
        autoFocus
      />
    </Dialog>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "var(--text-sm)",
        color: "var(--state-error)",
        margin: "8px 0",
      }}
    >
      {text}
    </div>
  );
}
