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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  ProgressBar,
  Spinner,
  StatusPill,
  Table,
  Tabs,
  TextInput,
} from "../../components";
import {
  api,
  type Company,
  type CompanyBudgetView,
  type CompanyMember,
  type CompanyUsage,
  type CompanyWorkspaceRuns,
  type CompanyWorkspaceWorkflow,
} from "../../lib/api";
import { runStatusUi } from "../../lib/run-status";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { CompanyGroupsCard } from "./CompanyGroups";
import { workspaceLabel } from "../../workspace/WorkspaceSwitcher";
import { usd } from "./insights.logic";

type DrillTab = "runs" | "workflows";
type ConsoleTab = "workspaces" | "usage" | "groups";

interface Drill {
  tenantId: string;
  displayName: string | null;
  tab: DrillTab;
}

/** Initials for a workspace/company mark — first letters of up to two words. */
function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Format the rollup window (usage.range) as a human billing period. */
function billingPeriod(range: CompanyUsage["range"]): string {
  if (!range.from || !range.to) return "this month";
  const fmt = (s: string) =>
    // Pin to UTC: range.from/to are date-only ISO strings, which would otherwise
    // render off-by-one in timezones behind UTC.
    new Date(s).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

/** Threshold color for a budget ratio: red > 85%, warn amber > 70%, else success green. */
function budgetColor(pct: number): string {
  if (pct > 85) return "var(--state-error)";
  if (pct > 70) return "var(--state-paused)";
  return "var(--state-done)";
}

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

/* ---------------- Stat band ---------------- */

/** One KPI tile — built inline (StatCard has no of-budget subtext / threshold bar). */
function KpiTile({
  label,
  value,
  accent,
  sub,
  bar,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  sub?: ReactNode;
  bar?: { pct: number; color: string };
}) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg, 12px)",
        padding: "13px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: "var(--ink-2)",
          textTransform: "uppercase",
          letterSpacing: ".04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: "var(--weight-semibold)",
          color: accent ?? "var(--ink)",
          lineHeight: 1.15,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          {sub}
        </div>
      )}
      {bar && (
        <div style={{ marginTop: 2 }}>
          <ProgressBar value={bar.pct} color={bar.color} />
        </div>
      )}
    </div>
  );
}

function StatBand({
  usage,
  budget,
  seats,
}: {
  usage: CompanyUsage;
  budget: CompanyBudgetView | null;
  seats: number | null;
}) {
  // Spend-of-budget uses MTD spend / monthly cap (BOTH month-to-date). Never divide the
  // range/30d rollup by the monthly cap — different windows. Falls back to the 30d rollup
  // spend (no budget framing) when no company budget is configured.
  const cap = budget?.budget?.monthlyCapUsd ?? null;
  const mtd = budget?.mtdSpendUsd ?? null;
  const hasBudget = cap != null && cap > 0 && mtd != null;
  const pct = hasBudget ? (mtd / cap) * 100 : 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12,
        marginBottom: 8,
      }}
    >
      {hasBudget ? (
        <KpiTile
          label="Spend · month to date"
          value={usd(mtd)}
          accent={budgetColor(pct)}
          sub={`of ${usd(cap)} · ${Math.round(pct)}%`}
          bar={{ pct, color: budgetColor(pct) }}
        />
      ) : (
        <KpiTile
          label="Company spend (30d)"
          value={usd(usage.totals.costUsd)}
        />
      )}
      <KpiTile
        label="Tokens (30d)"
        value={usage.totals.totalTokens.toLocaleString()}
      />
      <KpiTile label="Metered calls (30d)" value={String(usage.totals.calls)} />
      <KpiTile label="Seats" value={seats == null ? "—" : String(seats)} />
    </div>
  );
}

/* ---------------- Workspaces tab ---------------- */

type WorkspaceRow = CompanyUsage["byWorkspace"][number];

/** Neutral environment dots — `byEnvironment` gives only opaque environmentIds, not a
 *  prod/uat/sandbox KIND, so we can't legitimately use the --env-* accents. Show one
 *  neutral dot per environment with activity (dim placeholder when none). */
function EnvDots({ envs }: { envs: WorkspaceRow["byEnvironment"] }) {
  if (envs.length === 0) {
    return (
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 99,
          background: "var(--line-2)",
        }}
        title="No environment activity"
      />
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {envs.slice(0, 4).map((e, i) => (
        <span
          key={e.environmentId ?? `default-${i}`}
          title={e.environmentId ?? "default"}
          style={{
            width: 8,
            height: 8,
            borderRadius: 99,
            background: "var(--ink-2)",
          }}
        />
      ))}
      {envs.length > 4 && (
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
          +{envs.length - 4}
        </span>
      )}
    </span>
  );
}

function WorkspacesTab({
  usage,
  rowBusy,
  memberTenantIds,
  onDrill,
  onRename,
  onArchive,
  onOpen,
}: {
  usage: CompanyUsage;
  rowBusy: string | null;
  memberTenantIds: Set<string>;
  onDrill: (w: WorkspaceRow) => void;
  onRename: (w: WorkspaceRow) => void;
  onArchive: (w: WorkspaceRow) => void;
  onOpen: (w: WorkspaceRow) => void;
}) {
  const total = usage.totals.costUsd;
  // Secondary company-management actions live in their own cell; stop row-click propagation so
  // interacting with them never triggers the drill-in (the row's read-only observe action).
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <Card pad={false} style={{ overflow: "hidden" }}>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ minWidth: 680 }}>
          <Table
            columns={[
              {
                key: "name",
                header: "Workspace",
                render: (w: WorkspaceRow) => (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 9,
                    }}
                  >
                    <Avatar
                      initials={initialsOf(
                        workspaceLabel(w.tenantId, w.displayName ?? undefined),
                      )}
                      size={26}
                    />
                    <span style={{ color: "var(--ink)" }}>
                      {workspaceLabel(w.tenantId, w.displayName ?? undefined)}
                    </span>
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
                key: "envs",
                header: "Environments",
                render: (w) => <EnvDots envs={w.byEnvironment} />,
              },
              {
                key: "spend",
                header: "Spend",
                render: (w) => (
                  <div style={{ minWidth: 130 }}>
                    <div style={{ color: "var(--ink)", marginBottom: 4 }}>
                      {usd(w.costUsd)}
                    </div>
                    {/* No per-workspace budget exists in the company API — this bar shows the
                        workspace's SHARE of company spend (not an of-budget gauge), so no
                        red/warn thresholds. Budget thresholds live at the company level. */}
                    <ProgressBar
                      value={total > 0 ? (w.costUsd / total) * 100 : 0}
                      color="var(--brand)"
                    />
                  </div>
                ),
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
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      justifyContent: "flex-end",
                    }}
                  >
                    {/* Secondary company-management actions — wrapped so their clicks never
                        bubble up to the row's drill-in (read-only observe) action. */}
                    <div
                      onClick={stop}
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRename(w)}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={rowBusy === w.tenantId}
                        onClick={() => onArchive(w)}
                      >
                        {w.archived ? "Unarchive" : "Archive"}
                      </Button>
                      {memberTenantIds.has(w.tenantId) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => onOpen(w)}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                    {/* Drill-in chevron — a real focusable button so keyboard users can open
                        the READ-ONLY workspace observer (the row's onRowClick handles the
                        mouse path; stopPropagation avoids a double-invoke via the row). */}
                    <button
                      type="button"
                      aria-label={`Open ${workspaceLabel(
                        w.tenantId,
                        w.displayName ?? undefined,
                      )} (read-only)`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDrill(w);
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 32,
                        minHeight: 32,
                        padding: 0,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--ink-3)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </div>
                ),
              },
            ]}
            rows={usage.byWorkspace}
            rowKey={(w) => w.tenantId}
            onRowClick={onDrill}
          />
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Usage tab ---------------- */

function UsageTab({
  usage,
  budget,
}: {
  usage: CompanyUsage;
  budget: CompanyBudgetView | null;
}) {
  const max = Math.max(0, ...usage.byWorkspace.map((w) => w.costUsd));
  const rows = [...usage.byWorkspace].sort((a, b) => b.costUsd - a.costUsd);
  const cap = budget?.budget?.monthlyCapUsd ?? null;
  const mtd = budget?.mtdSpendUsd ?? null;
  const hasBudget = cap != null && cap > 0 && mtd != null;
  const remaining = budget?.remainingUsd ?? null;

  return (
    <Card>
      <div
        style={{
          fontWeight: "var(--weight-semibold)",
          marginBottom: 12,
        }}
      >
        Spend by workspace (30d)
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No usage yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((w) => (
            <div key={w.tenantId}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: "var(--text-sm)",
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {workspaceLabel(w.tenantId, w.displayName ?? undefined)}
                </span>
                <span style={{ color: "var(--ink-2)", flexShrink: 0 }}>
                  {usd(w.costUsd)}
                </span>
              </div>
              <ProgressBar
                value={max > 0 ? (w.costUsd / max) * 100 : 0}
                color="var(--brand)"
              />
            </div>
          ))}
        </div>
      )}

      {/* Company total + pooled-budget line (§8) — the of-budget framing the differentiator asks
          for, at the level the API actually provides a budget (company-wide, not per-workspace). */}
      <div
        style={{
          borderTop: "1px solid var(--line)",
          marginTop: 14,
          paddingTop: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            fontSize: "var(--text-body)",
          }}
        >
          <span style={{ color: "var(--ink-2)" }}>Company total (30d)</span>
          <span
            style={{
              color: "var(--ink)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {usd(usage.totals.costUsd)}
          </span>
        </div>
        {hasBudget ? (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: "var(--text-sm)",
                marginBottom: 4,
              }}
            >
              <span style={{ color: "var(--ink-2)" }}>
                Pooled budget · month to date
              </span>
              <span style={{ color: "var(--ink-2)" }}>
                {usd(mtd)} of {usd(cap)}
                {remaining != null && ` · ${usd(Math.max(0, remaining))} left`}
              </span>
            </div>
            <ProgressBar
              value={(mtd / cap) * 100}
              color={budgetColor((mtd / cap) * 100)}
            />
          </div>
        ) : (
          <div
            style={{
              marginTop: 8,
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No company budget cap configured.
          </div>
        )}
      </div>
    </Card>
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
            loading={busy}
            disabled={!email.trim()}
            onClick={() => void add()}
          >
            Add
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
