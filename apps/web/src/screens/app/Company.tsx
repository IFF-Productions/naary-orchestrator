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
  type CompanyMember,
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
  const { workspaces, setActive, refresh } = useWorkspace();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<CompanyUsage | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rename, setRename] = useState<{
    tenantId: string;
    name: string;
  } | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

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
  const isOwner = company.role === "owner";
  const memberTenantIds = new Set(workspaces.map((w) => w.tenantId));

  const reloadUsage = () => api.getCompanyUsage(company.id).then(setUsage);

  async function toggleArchive(tenantId: string, archived: boolean) {
    setRowBusy(tenantId);
    setErr(null);
    try {
      await api.setCompanyWorkspaceArchived(company.id, tenantId, archived);
      await reloadUsage();
      // The switcher hides archived workspaces — refresh the list so it reflects the change.
      await refresh();
    } catch {
      setErr(
        archived
          ? "Couldn't archive the workspace."
          : "Couldn't unarchive the workspace.",
      );
    } finally {
      setRowBusy(null);
    }
  }

  async function saveRename() {
    if (!rename || !rename.name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.renameCompanyWorkspace(
        company.id,
        rename.tenantId,
        rename.name.trim(),
      );
      setRename(null);
      await reloadUsage();
      await refresh(); // the switcher shows displayName too
    } catch {
      setErr("Couldn't rename the workspace.");
    } finally {
      setBusy(false);
    }
  }

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
                  render: (w: CompanyUsage["byWorkspace"][number]) => (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {workspaceLabel(w.tenantId, w.displayName ?? undefined)}
                      {w.archived && (
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "1px 7px",
                            borderRadius: 99,
                            border: "1px solid var(--line)",
                            color: "var(--ink-3)",
                          }}
                        >
                          Archived
                        </span>
                      )}
                    </span>
                  ),
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
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRename({
                            tenantId: w.tenantId,
                            name: w.displayName ?? "",
                          })
                        }
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={rowBusy === w.tenantId}
                        onClick={() =>
                          void toggleArchive(w.tenantId, !w.archived)
                        }
                      >
                        {w.archived ? "Unarchive" : "Archive"}
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

          <MembersCard companyId={company.id} isOwner={isOwner} />
        </>
      )}

      <Dialog
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Rename workspace"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!rename?.name.trim()}
              onClick={() => void saveRename()}
            >
              Save
            </Button>
          </>
        }
      >
        <TextInput
          value={rename?.name ?? ""}
          onChange={(e) =>
            setRename((r) => (r ? { ...r, name: e.target.value } : r))
          }
          placeholder="Acme Production"
          autoFocus
        />
      </Dialog>

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

/**
 * Company members (Slice 4): list with roles; owner-only add form (email + owner/admin —
 * NO invitations: the email must already have signed in, mirroring Team.tsx's invite style);
 * remove is owner-only except self-leave. Last-owner demote/removal is refused server-side (409).
 */
function MembersCard({
  companyId,
  isOwner,
}: {
  companyId: string;
  isOwner: boolean;
}) {
  const [members, setMembers] = useState<CompanyMember[] | null>(null);
  const [myUid, setMyUid] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "admin">("admin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMembers(null);
    setErr(null);
    api
      .listCompanyMembers(companyId)
      .then((m) => live && setMembers(m))
      .catch(() => live && setErr("Couldn't load the company members."));
    api
      .getMe()
      .then((me) => live && setMyUid(me.subject ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [companyId]);

  async function add() {
    if (!email.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addCompanyMember(companyId, email.trim(), role);
      setEmail("");
      setMembers(await api.listCompanyMembers(companyId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // http() throws generic "<METHOD> <path> → <status>" errors — map the meaningful ones.
      if (msg.includes("→ 404")) {
        setErr("No account with that email — they must sign in first.");
      } else if (msg.includes("→ 409")) {
        setErr("A company must keep at least one owner.");
      } else if (msg.includes("→ 403")) {
        setErr("Only the company owner can manage members.");
      } else {
        setErr("Couldn't add the member.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setErr(null);
    try {
      await api.removeCompanyMember(companyId, userId);
      setMembers((ms) => (ms ?? []).filter((m) => m.userId !== userId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setErr(
        msg.includes("→ 409")
          ? "A company must keep at least one owner."
          : "Couldn't remove the member.",
      );
    }
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <div
        style={{
          fontWeight: "var(--weight-semibold)",
          marginBottom: 10,
        }}
      >
        Members
      </div>
      {err && <ErrorLine text={err} />}
      {isOwner && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <TextInput
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@company.com"
            type="email"
            style={{ flex: 1 }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "owner" | "admin")}
            style={{ padding: "8px 10px", borderRadius: "var(--radius-md)" }}
          >
            <option value="admin">admin</option>
            <option value="owner">owner</option>
          </select>
          <Button
            variant="primary"
            disabled={busy || !email.trim()}
            onClick={() => void add()}
          >
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      )}
      {members === null ? (
        <Spinner />
      ) : members.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No members.
        </div>
      ) : (
        members.map((m) => (
          <div
            key={m.userId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "9px 2px",
              borderTop: "1px solid var(--line)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.email ?? m.userId}
                {m.userId === myUid ? " (you)" : ""}
              </span>
            </div>
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: m.role === "owner" ? "var(--brand)" : "var(--ink-2)",
              }}
            >
              {m.role}
            </span>
            {(isOwner || m.userId === myUid) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(m.userId)}
              >
                {m.userId === myUid ? "Leave" : "Remove"}
              </Button>
            )}
          </div>
        ))
      )}
    </Card>
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
