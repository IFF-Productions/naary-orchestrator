/**
 * Members tab — role legend chips, the member table (avatar · role chip ·
 * "Can approve" · joined · kebab) and pending invitations as the comp's footer
 * rows (dashed envelope avatar, "Invite pending · role", revoke).
 *
 * OMITTED vs the comp (data honesty):
 *  - "Last active" — the backend stores no activity timestamp; we show "Joined"
 *    (Membership.createdAt) instead, which is real.
 *  - "Resend" on pending invites — no resend endpoint exists (invitees join by
 *    signing in with the invited email; nothing is re-sendable). Revoke only.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components";
import type { Member, PermissionGroup } from "../../../lib/api";
import {
  deriveCanApprove,
  displayName,
  groupsOf,
  initials,
  ROLE_AVATAR,
  roleColor,
  roleCounts,
  shortDate,
} from "./model";

const ALL_ROLES = ["owner", "admin", "member"];

/** grid template shared by the header + rows (approve column widest, like the comp) */
const GRID = "2fr 1fr 1.6fr 0.8fr 44px";

function RoleChip({ role }: { role: string }) {
  const c = roleColor(role);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        color: c,
        border: `1px solid color-mix(in srgb, ${c} 55%, transparent)`,
        background: `color-mix(in srgb, ${c} 8%, transparent)`,
        borderRadius: "var(--radius-pill)",
        padding: "3px 10px",
        textTransform: "capitalize",
      }}
    >
      {role}
    </span>
  );
}

interface MenuItem {
  label: string;
  danger?: boolean;
  onPick: () => void;
}

/** Minimal kebab popover (local — no shared primitive for menus yet). */
function KebabMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 30,
          height: 30,
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink-faint)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="more" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: 34,
            right: 0,
            zIndex: 30,
            minWidth: 168,
            background: "var(--card)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-raised)",
            padding: 5,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onPick();
              }}
              style={{
                textAlign: "left",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "7px 10px",
                borderRadius: "var(--radius-xs)",
                fontSize: "var(--text-sm)",
                fontFamily: "var(--font-sans)",
                color: it.danger ? "var(--state-error)" : "var(--ink-soft)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dashed-circle envelope avatar for pending invitations (comp footer row). */
function InviteAvatar() {
  return (
    <span
      style={{
        width: 36,
        height: 36,
        flex: "none",
        borderRadius: "50%",
        border: "1px dashed var(--line-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink-3)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4 6h16v12H4zM4 7l8 6 8-6"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    </span>
  );
}

export function MembersTable({
  members,
  groups,
  restricted,
  myRole,
  onChangeRole,
  onRemove,
  onRevoke,
}: {
  members: Member[];
  /** null = the caller can't list groups (owner/admin-only endpoint). */
  groups: PermissionGroup[] | null;
  /** Does ANY grant exist (the cliff)? null when groups are unknown. */
  restricted: boolean | null;
  myRole: string | null;
  onChangeRole: (m: Member, role: string) => void;
  onRemove: (m: Member) => void;
  onRevoke: (m: Member) => void;
}) {
  const canManage = myRole === "owner" || myRole === "admin";
  const active = members.filter((m) => m.status === "active");
  const invited = members.filter((m) => m.status === "invited");
  const counts = roleCounts(members);

  /** Admins manage member-level rows only; anything involving admin/owner is
   *  owner-only (server-enforced — the menu mirrors it). */
  function menuFor(m: Member): MenuItem[] {
    const items: MenuItem[] = [];
    const elevated = m.role === "owner" || m.role === "admin";
    if (myRole === "owner") {
      for (const r of ALL_ROLES) {
        if (r !== m.role)
          items.push({
            label: `Change role to ${r}`,
            onPick: () => onChangeRole(m, r),
          });
      }
    }
    if (canManage && (myRole === "owner" || !elevated)) {
      items.push({
        label: "Remove member",
        danger: true,
        onPick: () => onRemove(m),
      });
    }
    return items;
  }

  return (
    <div>
      {/* role legend */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        {ALL_ROLES.map((r) => (
          <span
            key={r}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11.5,
              color: "var(--ink-2)",
              border: "1px solid var(--line-mid)",
              background: "var(--panel)",
              borderRadius: "var(--radius-pill)",
              padding: "5px 11px",
              textTransform: "capitalize",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: roleColor(r),
              }}
            />
            {r} · {counts[r] ?? 0}
          </span>
        ))}
        {invited.length > 0 && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11.5,
              color: "var(--ink-2)",
              border: "1px solid var(--line-mid)",
              background: "var(--panel)",
              borderRadius: "var(--radius-pill)",
              padding: "5px 11px",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--state-paused)",
              }}
            />
            Invited · {invited.length}
          </span>
        )}
      </div>

      {/* table */}
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--panel)",
          borderRadius: 14,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: 680 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              padding: "11px 18px",
              borderBottom: "1px solid var(--line)",
              background: "var(--card-2)",
              fontSize: 10.5,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--ink-faint)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>Member</span>
            <span>Role</span>
            <span>Can approve</span>
            <span>Joined</span>
            <span />
          </div>

          {active.map((m) => {
            const approve = deriveCanApprove(
              m,
              restricted,
              groupsOf(groups ?? [], m.userId ?? m.id),
            );
            const menu = menuFor(m);
            return (
              <div
                key={m.id}
                className="team-row"
                style={{
                  display: "grid",
                  gridTemplateColumns: GRID,
                  alignItems: "center",
                  padding: "12px 18px",
                  borderBottom: "1px solid var(--line)",
                  transition: "background .12s",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minWidth: 0,
                    paddingRight: 10,
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      flex: "none",
                      borderRadius: "50%",
                      background: ROLE_AVATAR[m.role] ?? "var(--avatar-bg)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-semibold)",
                      color: "#fff",
                    }}
                  >
                    {initials(m.email)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "var(--text-body)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayName(m.email)}
                    </div>
                    <div
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.email}
                    </div>
                  </div>
                </div>
                <div>
                  <RoleChip role={m.role} />
                </div>
                <div style={{ paddingRight: 10 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: approve.none ? "var(--ink-3)" : "var(--ink-2)",
                      lineHeight: 1.4,
                    }}
                  >
                    {approve.label}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    {approve.detail}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                  {shortDate(m.createdAt)}
                </div>
                {menu.length > 0 ? (
                  <KebabMenu items={menu} label={`Actions for ${m.email}`} />
                ) : (
                  <span />
                )}
              </div>
            );
          })}

          {active.length === 0 && (
            <div
              style={{
                padding: 16,
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              No members yet — invite your first teammate.
            </div>
          )}

          {/* pending invitations (comp footer rows) */}
          {invited.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 18px",
                background: "var(--card-2)",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <InviteAvatar />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink-soft)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.email}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--state-paused)",
                  }}
                >
                  Invite pending · {m.role} · sent {shortDate(m.createdAt)}
                </div>
              </div>
              <span
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                }}
              >
                joins on first sign-in with this email
              </span>
              {canManage &&
                (myRole === "owner" ||
                  (m.role !== "owner" && m.role !== "admin")) && (
                  <button
                    type="button"
                    onClick={() => onRevoke(m)}
                    style={{
                      height: 30,
                      padding: "0 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--line-2)",
                      background: "var(--card)",
                      color: "var(--ink-2)",
                      fontSize: 11.5,
                      fontFamily: "var(--font-sans)",
                      cursor: "pointer",
                    }}
                  >
                    Revoke
                  </button>
                )}
            </div>
          ))}
        </div>
      </div>
      <style>{`.team-row:hover{background:var(--hover);}`}</style>
    </div>
  );
}
