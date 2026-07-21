import {
  Avatar,
  Button,
  Card,
  Icon,
  ProgressBar,
  Table,
} from "../../../components";
import type { CompanyUsage } from "../../../lib/api";
import { workspaceLabel } from "../../../workspace/WorkspaceSwitcher";
import { usd } from "../insights.logic";
import { initialsOf } from "./helpers";
import { EnvDots } from "./stat-band";
import type { WorkspaceRow } from "./types";

export function WorkspacesTab({
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
