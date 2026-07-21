// Company console (COMPANIES.md §7.3): a company admin's cross-workspace view — usage rollup
// + READ-ONLY drill-down into each member workspace's runs/workflows. All reads go through the
// company-authz path (§4); run detail stays workspace-gated, so drill-down rows are not links.
//
// Layout "2a — stat band + workspaces table": a header (company mark + rollup summary + admin
// pill), a KPI band from the REAL rollup/budget, and three tabs (Workspaces · Usage · Groups).
// This is a RESTYLE over the existing logic — every API call + state is preserved. The console
// only OBSERVES member workspaces (you don't edit their runs); the company-admin writes it keeps
// (rename displayName, archive membership, attach, members) are company management, not workspace
// content edits, and stay gated by the §4 company-authz path.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Spinner,
  Tabs,
  TextInput,
} from "../../components";
import {
  api,
  type Company,
  type CompanyBudgetView,
  type CompanyUsage,
} from "../../lib/api";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { CompanyGroupsCard } from "./CompanyGroups";
import { billingPeriod, initialsOf } from "./company/helpers";
import { ErrorLine } from "./company/misc";
import { StatBand } from "./company/stat-band";
import { WorkspacesTab } from "./company/WorkspacesTab";
import { UsageTab } from "./company/UsageTab";
import { MembersCard } from "./company/MembersCard";
import { DrillPanel } from "./company/DrillPanel";
import { AttachCurrentWorkspace, CreateCompanyDialog } from "./company/dialogs";
import type { Drill } from "./company/types";

type ConsoleTab = "workspaces" | "usage" | "groups";

export function Company() {
  const navigate = useNavigate();
  const { workspaces, setActive, refresh } = useWorkspace();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<CompanyUsage | null>(null);
  const [budget, setBudget] = useState<CompanyBudgetView | null>(null);
  const [seats, setSeats] = useState<number | null>(null);
  const [tab, setTab] = useState<ConsoleTab>("workspaces");
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
    setBudget(null);
    setSeats(null);
    setDrill(null);
    setTab("workspaces");
    // Clear any prior failure so a stale error can't linger after a successful switch.
    setErr(null);
    api
      .getCompanyUsage(companyId)
      .then((u) => live && setUsage(u))
      .catch(() => live && setErr("Couldn't load the company usage rollup."));
    // Budget (§8) drives the "Spend of budget" KPI + the Usage-tab pooled-budget line.
    // Read-only; best-effort — a missing budget just hides the of-budget framing.
    api
      .getCompanyBudget(companyId)
      .then((b) => live && setBudget(b))
      .catch(() => {});
    // Seats KPI — a lightweight member count (MembersCard fetches its own list for management).
    api
      .listCompanyMembers(companyId)
      .then((m) => live && setSeats(m.length))
      .catch(() => {});
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

  const consoleTabs: { value: ConsoleTab; label: string }[] = [
    { value: "workspaces", label: "Workspaces" },
    { value: "usage", label: "Usage" },
    // Company-wide permission groups (RBAC-GROUPS §9) — owner-only management.
    ...(isOwner ? [{ value: "groups" as const, label: "Groups" }] : []),
  ];
  const activeTab: ConsoleTab =
    tab === "groups" && !isOwner ? "workspaces" : tab;

  return (
    <div
      style={{
        padding: "22px 28px 40px",
        maxWidth: 1080,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      {/* ---- Header: company mark + rollup summary + admin pill + company actions ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 14,
          marginBottom: 18,
          flexWrap: "wrap",
        }}
      >
        <Avatar initials={initialsOf(company.name)} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: "var(--text-lg, 20px)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              {company.name}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                padding: "2px 9px",
                borderRadius: 99,
                color: "var(--brand)",
                border:
                  "1px solid color-mix(in srgb, var(--brand) 34%, transparent)",
                background: "var(--brand-soft)",
              }}
            >
              <Icon name="mode-admin" size={12} />
              {isOwner ? "Company owner" : "Company admin"}
            </span>
            {companies.length > 1 && (
              <select
                value={company.id}
                onChange={(e) => setCompanyId(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-sm)",
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            Company console ·{" "}
            {usage ? usage.byWorkspace.length : workspaces.length} workspace
            {(usage?.byWorkspace.length ?? workspaces.length) === 1
              ? ""
              : "s"}{" "}
            · billing {usage ? billingPeriod(usage.range) : "this month"}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            New company
          </Button>
          <AttachCurrentWorkspace
            companyId={company.id}
            reload={() => api.getCompanyUsage(company.id).then(setUsage)}
          />
        </div>
      </div>

      {err && <ErrorLine text={err} />}

      {usage === null ? (
        <Spinner />
      ) : (
        <>
          {/* ---- Rollup stat band: only KPIs the API actually provides ---- */}
          <StatBand usage={usage} budget={budget} seats={seats} />

          {/* ---- Tabs: Workspaces · Usage · Groups(owner) ---- */}
          <div style={{ margin: "6px 0 14px" }}>
            <Tabs<ConsoleTab>
              tabs={consoleTabs}
              active={activeTab}
              onChange={setTab}
            />
          </div>

          {activeTab === "workspaces" && (
            <WorkspacesTab
              usage={usage}
              rowBusy={rowBusy}
              memberTenantIds={memberTenantIds}
              onDrill={(w) =>
                setDrill({
                  tenantId: w.tenantId,
                  displayName: w.displayName,
                  tab: "runs",
                })
              }
              onRename={(w) =>
                setRename({ tenantId: w.tenantId, name: w.displayName ?? "" })
              }
              onArchive={(w) => void toggleArchive(w.tenantId, !w.archived)}
              onOpen={(w) => {
                setActive(w.tenantId);
                navigate("/app/runs");
              }}
            />
          )}

          {activeTab === "usage" && <UsageTab usage={usage} budget={budget} />}

          {activeTab === "groups" && isOwner && (
            <CompanyGroupsCard companyId={company.id} />
          )}

          {drill && (
            <DrillPanel
              companyId={company.id}
              drill={drill}
              setTab={(t) => setDrill({ ...drill, tab: t })}
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
