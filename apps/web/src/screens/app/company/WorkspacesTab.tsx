import {
  Avatar,
  Button,
  Card,
  Icon,
  ProgressBar,
  Table,
} from "../../../components";
import type { CompanyUsage } from "../../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
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
  const phone = useMediaQuery(PHONE_QUERY);

  // PHONE (#708): the table isn't clipped — it sits in the accepted `overflowX: auto` wrapper —
  // but measured at 390px it hid 320px, 47% of every row, behind a scroller with no visual
  // affordance. Spend, Tokens, Calls and every action were off-canvas, so the screen looked like
  // a list of names. Cards put the same cells on screen; same treatment as Runs/Workflows/Members.
  if (phone) {
    return (
      <Card pad={false} style={{ overflow: "hidden" }}>
        {usage.byWorkspace.map((w) => {
          const label = workspaceLabel(w.tenantId, w.displayName ?? undefined);
          return (
            <div
              key={w.tenantId}
              className="run-row"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "13px 16px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              {/* Identity + the drill-in, which were previously off-canvas together. */}
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <Avatar initials={initialsOf(label)} size={26} />
                <span
                  style={{
                    color: "var(--ink)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                {w.archived && (
                  <span
                    style={{
                      fontSize: 10.5,
                      padding: "1px 7px",
                      borderRadius: 99,
                      border: "1px solid var(--line)",
                      color: "var(--ink-3)",
                      flex: "none",
                    }}
                  >
                    Archived
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Open ${label} (read-only)`}
                  onClick={() => onDrill(w)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    // 44px on phone: a touch target, not a 32px pointer target.
                    minWidth: 44,
                    minHeight: 44,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--ink-3)",
                    flex: "none",
                  }}
                >
                  <Icon name="chevron-right" size={16} />
                </button>
              </div>

              {/* The hidden columns, now self-labelling — the header row is gone on phone. */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px 18px",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                }}
              >
                <span>
                  Spend{" "}
                  <span style={{ color: "var(--ink)" }}>{usd(w.costUsd)}</span>
                </span>
                <span>
                  Tokens{" "}
                  <span style={{ color: "var(--ink)" }}>
                    {w.totalTokens.toLocaleString()}
                  </span>
                </span>
                <span>
                  Calls <span style={{ color: "var(--ink)" }}>{w.calls}</span>
                </span>
                <EnvDots envs={w.byEnvironment} />
              </div>
              {/* Share of company spend — the same bar the table shows, not an of-budget gauge. */}
              <ProgressBar
                value={total > 0 ? (w.costUsd / total) * 100 : 0}
                color="var(--brand)"
              />

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button size="sm" variant="ghost" onClick={() => onRename(w)}>
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
            </div>
          );
        })}
      </Card>
    );
  }

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
