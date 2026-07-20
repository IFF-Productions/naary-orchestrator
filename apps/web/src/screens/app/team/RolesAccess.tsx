/**
 * Roles & access tab — capability cards for the REAL roles (owner/admin/member,
 * approval caps highlighted teal per the comp), a "Permission groups" card that
 * points at the Groups screen for the fine-grained six-verb grants, and (Slice 1)
 * an "Approval gates" card derived from REAL gates: workflows whose humanApproval
 * nodes carry approver routing / SLA / escalation config.
 *
 * Bounded derivation: the workflow list is one call; per-workflow graphs are
 * fetched lazily for at most GATE_SCAN_CAP workflows (newest first) so a large
 * workspace can't turn this tab into an N-request storm.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApprovalNodeConfig } from "@naary/dsl";
import { Button, Icon } from "../../../components";
import { api, type PermissionGroup } from "../../../lib/api";
import { totalGrantCount } from "../../../lib/permissions-logic";
import { ROLE_CARDS, roleColor } from "./model";

const APPROVE = "var(--node-approval)"; // teal — the HITL accent

function CapChip({ label, approval }: { label: string; approval?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: approval
          ? "var(--weight-semibold)"
          : "var(--weight-regular)",
        color: approval ? APPROVE : "var(--ink-2)",
        background: "var(--card-2)",
        border: `1px solid ${
          approval
            ? `color-mix(in srgb, ${APPROVE} 65%, transparent)`
            : "var(--line-mid)"
        }`,
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      {label}
    </span>
  );
}

export function RolesAccess({
  groups,
  counts,
}: {
  /** null = the caller can't list groups (owner/admin-only endpoint). */
  groups: PermissionGroup[] | null;
  /** Active-member counts per role (for the card headers). */
  counts: Record<string, number>;
}) {
  const navigate = useNavigate();
  const restricted = groups ? groups.some((g) => g.grants.length > 0) : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* role capabilities */}
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--panel)",
          borderRadius: 14,
          padding: "20px 22px",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            marginBottom: 4,
          }}
        >
          Roles & capabilities
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--ink-2)",
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          What each workspace role can do. Roles gate editing and — critically —
          who can approve human-in-the-loop gates.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {ROLE_CARDS.map((r) => {
            const n = counts[r.role] ?? 0;
            return (
              <div
                key={r.role}
                style={{
                  border: "1px solid var(--line-mid)",
                  background: "var(--card)",
                  borderRadius: 11,
                  padding: "13px 15px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: roleColor(r.role),
                    }}
                  />
                  <span
                    style={{
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                    }}
                  >
                    {r.name}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    {n} {n === 1 ? "person" : "people"}
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {r.caps.map((c) => (
                    <CapChip
                      key={c.label}
                      label={c.label}
                      approval={c.approval}
                    />
                  ))}
                </div>
                {r.note && (
                  <div
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                      marginTop: 8,
                    }}
                  >
                    {r.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* the honest roles → HITL bridge */}
        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            border: `1px solid color-mix(in srgb, ${APPROVE} 45%, transparent)`,
            background: `color-mix(in srgb, ${APPROVE} 7%, transparent)`,
            borderRadius: 11,
            padding: "11px 13px",
          }}
        >
          <span style={{ color: APPROVE, display: "flex", marginTop: 1 }}>
            <Icon name="approval" size={15} />
          </span>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ink-soft)",
              lineHeight: 1.5,
            }}
          >
            A gate is approvable by anyone with <b>Run</b> access on its
            workflow — owners and admins always; members according to their
            permission groups.
          </div>
        </div>
      </div>

      {/* permission groups summary → the Groups screen */}
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--panel)",
          borderRadius: 14,
          padding: "20px 22px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginBottom: 4,
          }}
        >
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Permission groups
          </div>
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              border: `1px solid ${APPROVE}`,
              color: APPROVE,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="key" size={11} />
          </span>
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--ink-2)",
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          Fine-grained grants below the role level: view / run / edit / delete /
          promote / create, scoped to environments and workflows. Run access is
          what makes a member able to approve a gate.
        </div>

        {groups === null ? (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              lineHeight: 1.5,
              marginBottom: 14,
            }}
          >
            Groups are managed by workspace owners and admins.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-2)",
                  border: "1px solid var(--line-mid)",
                  background: "var(--card-2)",
                  borderRadius: "var(--radius-pill)",
                  padding: "3px 10px",
                }}
              >
                {groups.length} group{groups.length === 1 ? "" : "s"}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-2)",
                  border: "1px solid var(--line-mid)",
                  background: "var(--card-2)",
                  borderRadius: "var(--radius-pill)",
                  padding: "3px 10px",
                }}
              >
                {totalGrantCount(groups)} grant
                {totalGrantCount(groups) === 1 ? "" : "s"}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: restricted
                    ? "var(--state-paused)"
                    : "var(--state-done)",
                  border: `1px solid color-mix(in srgb, ${
                    restricted ? "var(--state-paused)" : "var(--state-done)"
                  } 45%, transparent)`,
                  background: restricted
                    ? "var(--paused-soft)"
                    : "var(--done-soft)",
                  borderRadius: "var(--radius-pill)",
                  padding: "3px 10px",
                }}
              >
                {restricted
                  ? "Restriction on — members are deny-by-default"
                  : "No grants yet — members unrestricted"}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 14,
              }}
            >
              {groups.slice(0, 5).map((g) => {
                const grantsRun = g.grants.some((gr) => gr.canRun);
                return (
                  <div
                    key={g.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      border: "1px solid var(--line-mid)",
                      background: "var(--card)",
                      borderRadius: 11,
                      padding: "10px 13px",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "var(--text-sm)",
                          fontWeight: "var(--weight-semibold)",
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {g.name}
                      </div>
                      <div
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-3)",
                        }}
                      >
                        {g.members.length} member
                        {g.members.length === 1 ? "" : "s"} · {g.grants.length}{" "}
                        grant
                        {g.grants.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    {grantsRun && (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: "var(--weight-semibold)",
                          color: APPROVE,
                          border: `1px solid color-mix(in srgb, ${APPROVE} 55%, transparent)`,
                          borderRadius: "var(--radius-pill)",
                          padding: "2px 9px",
                          flex: "none",
                        }}
                      >
                        grants Run → can approve
                      </span>
                    )}
                  </div>
                );
              })}
              {groups.length === 0 && (
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-3)",
                  }}
                >
                  No groups yet — every member keeps full access until the first
                  grant is saved.
                </div>
              )}
              {groups.length > 5 && (
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  + {groups.length - 5} more
                </div>
              )}
            </div>
          </>
        )}

        <Button
          variant="secondary"
          iconRight="external"
          onClick={() => navigate("/app/groups")}
        >
          Open Groups
        </Button>
      </div>

      {/* Slice 1: real approval-gate routing derived from the workflows' graphs */}
      <ApprovalGatesCard groups={groups} />
    </div>
  );
}

/** How many workflows (newest first) we scan for routed approval gates. */
const GATE_SCAN_CAP = 8;

interface GateRow {
  workflowKey: string;
  workflowName: string;
  title: string;
  approverLabels: string[];
  slaHours?: number;
  escalateAfterHours?: number;
  escalateTo?: string;
}

/**
 * "Approval gates" — derives REAL per-gate routing (approvers/SLA/escalation) from the
 * workflows' saved graphs. Truthful by construction: it lists only humanApproval nodes
 * whose config actually carries Slice-1 fields; when none exist it says so.
 */
function ApprovalGatesCard({ groups }: { groups: PermissionGroup[] | null }) {
  const [rows, setRows] = useState<GateRow[] | null>(null);
  const [scanned, setScanned] = useState<{ n: number; total: number } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await api.listGraphs();
        // Newest-updated first, bounded — the lazy/bounded fetch the slice calls for.
        const pick = [...list]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, GATE_SCAN_CAP);
        const graphs = await Promise.all(
          pick.map((g) => api.getGraph(g.workflowKey).catch(() => null)),
        );
        if (!alive) return;
        const nameById = new Map((groups ?? []).map((g) => [g.id, g.name]));
        const found: GateRow[] = [];
        for (const g of graphs) {
          if (!g) continue;
          for (const node of g.graph.nodes) {
            if (node.type !== "humanApproval") continue;
            const cfg = (node.config ?? {}) as ApprovalNodeConfig;
            const emails = cfg.approvers?.emails ?? [];
            const groupIds = cfg.approvers?.groupIds ?? [];
            const routed =
              emails.length > 0 ||
              groupIds.length > 0 ||
              cfg.slaHours !== undefined ||
              cfg.escalateAfterHours !== undefined;
            if (!routed) continue;
            found.push({
              workflowKey: g.workflowKey,
              workflowName: g.name,
              title: cfg.title?.trim() || node.id,
              approverLabels: [
                ...emails,
                ...groupIds.map((id) => `@${nameById.get(id) ?? id}`),
              ],
              slaHours: cfg.slaHours,
              escalateAfterHours: cfg.escalateAfterHours,
              escalateTo: cfg.escalateTo,
            });
          }
        }
        setRows(found);
        setScanned({ n: pick.length, total: list.length });
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [groups]);

  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--panel)",
        borderRadius: 14,
        padding: "20px 22px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 6,
        }}
      >
        <span style={{ color: APPROVE, display: "flex" }}>
          <Icon name="approval" size={16} />
        </span>
        <span style={{ fontSize: 14.5, fontWeight: "var(--weight-bold)" }}>
          Approval gates
        </span>
      </div>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: 1.55,
          marginBottom: 12,
        }}
      >
        Gates that route to specific approvers or carry an SLA/escalation — read
        from the workflows' actual graphs.
      </div>

      {rows === null && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          Scanning workflows…
        </div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No routed gates yet — add approvers, an SLA, or escalation on a
          workflow's approval step (canvas → the gate's Parameters).
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => (
            <div
              key={`${r.workflowKey}:${r.title}`}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: "9px 12px",
                background: "var(--card)",
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {r.title}
                <span
                  style={{
                    color: "var(--ink-faint)",
                    fontWeight: "var(--weight-regular)",
                  }}
                >
                  {" "}
                  · {r.workflowName}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {r.approverLabels.map((a) => (
                  <CapChip key={a} label={a} approval />
                ))}
                {r.slaHours !== undefined && (
                  <CapChip label={`SLA ${r.slaHours}h`} />
                )}
                {r.escalateAfterHours !== undefined && (
                  <CapChip
                    label={`escalates ${r.escalateAfterHours}h${r.escalateTo ? ` → ${r.escalateTo}` : ""}`}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {scanned && scanned.total > scanned.n && (
        <div
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            marginTop: 10,
          }}
        >
          Scanned the {scanned.n} most recently updated of {scanned.total}{" "}
          workflows.
        </div>
      )}
    </div>
  );
}
