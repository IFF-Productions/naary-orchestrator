/**
 * Members tab — role legend chips, the member table (avatar · role chip ·
 * "Can approve" · last active · kebab) and pending invitations as the comp's footer
 * rows (dashed envelope avatar, "Invite pending · role", revoke).
 *
 * "Last active" (#489) is Membership.lastActiveAt, stamped by the auth guard on each
 * authenticated request in the workspace (5-min-throttled); "Never" until first seen.
 *
 * OMITTED vs the comp (data honesty):
 *  - "Resend" on pending invites — no resend endpoint exists (invitees join by
 *    signing in with the invited email; nothing is re-sendable). Revoke only.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components";
import type { Member, PermissionGroup } from "../../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
import {
  deriveCanApprove,
  displayName,
  groupsOf,
  initials,
  lastActive,
  ROLE_AVATAR,
  roleColor,
  roleCounts,
  shortDate,
} from "./model";

const ALL_ROLES = ["owner", "admin", "member"];

/** grid template shared by the header + rows (approve column widest, like the comp) */
const GRID = "2fr 1fr 1.6fr 0.8fr 44px";

/**
 * Desktop table width. The `overflowX: "auto"` wrapper below is the wave's accepted
 * pattern #3 — but measured at 390px it hid 324 of these 680px (48% of the row, the
 * role/approve/last-active columns AND the kebab) behind a scroller with no visual
 * affordance (#511). So on phone the rows render as stacked, self-labelling cards
 * instead — the Runs/Workflows reference treatment — and this floor applies only from
 * tablet up, where it costs nothing: at 820px the content box is ~762px, so 680 fits
 * outright and the measured hidden width is 0.
 */
const TABLE_MIN_WIDTH = 680;

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
          className="menu-pop"
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
  // Phone: the 5-column grid can't fit — each member renders as a stacked card instead
  // (see TABLE_MIN_WIDTH).
  const phone = useMediaQuery(PHONE_QUERY);
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
        <div style={{ minWidth: phone ? undefined : TABLE_MIN_WIDTH }}>
          {/* Column header — tablet/desktop only; on phone the cards are self-labelling. */}
          {!phone && (
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
              <span>Last active</span>
              <span />
            </div>
          )}

          {active.map((m) => {
            const approve = deriveCanApprove(
              m,
              restricted,
              groupsOf(groups ?? [], m.userId ?? m.id),
            );
            const menu = menuFor(m);
            // Cells are built ONCE and reused by both layouts below — only the
            // arrangement differs (the Workflows.tsx idiom).
            const identity = (
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
            );
            const approveCell = (
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
            );
            const lastActiveCell = (
              <div
                style={{ fontSize: 11.5, color: "var(--ink-faint)" }}
                title={`Joined ${shortDate(m.createdAt)}`}
              >
                {lastActive(m.lastActiveAt)}
              </div>
            );
            const kebab =
              menu.length > 0 ? (
                <KebabMenu items={menu} label={`Actions for ${m.email}`} />
              ) : (
                <span />
              );

            // Phone: a stacked, self-labelling card. Row 1 keeps the identity next to
            // the kebab (both were previously off-canvas together); row 2 wraps the
            // role chip + approve rights + last-active, each of which was a hidden
            // column at 390px.
            if (phone) {
              return (
                <div
                  key={m.id}
                  className="team-row"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: "13px 16px",
                    borderBottom: "1px solid var(--line)",
                    transition: "background .12s",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    {identity}
                    {kebab}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <RoleChip role={m.role} />
                    {approveCell}
                    {lastActiveCell}
                  </div>
                </div>
              );
            }

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
                {identity}
                <div>
                  <RoleChip role={m.role} />
                </div>
                {approveCell}
                {lastActiveCell}
                {kebab}
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
          {invited.map((m) => {
            const revoke = canManage &&
              (myRole === "owner" ||
                (m.role !== "owner" && m.role !== "admin")) && (
                <button
                  type="button"
                  onClick={() => onRevoke(m)}
                  style={{
                    // Phone: 44px touch minimum (this is an inline-styled button, so
                    // components.css's `.btn-icon` rule can't reach it).
                    height: phone ? 44 : 30,
                    flex: "none",
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
              );
            const hint = (
              <span
                style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
              >
                joins on first sign-in with this email
              </span>
            );
            const identity = (
              <>
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
              </>
            );

            // Phone: same two-band card as an active member. `flexWrap` alone was not
            // enough — the hint and Revoke are `flex: none` siblings, so they held the
            // first line and squeezed the email column to a few characters (the
            // GroupDetailHeader lesson). Stack instead.
            if (phone) {
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: "13px 16px",
                    background: "var(--card-2)",
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 12 }}
                  >
                    {identity}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    {hint}
                    {revoke}
                  </div>
                </div>
              );
            }

            return (
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
                {identity}
                {hint}
                {revoke}
              </div>
            );
          })}
        </div>
      </div>
      <style>{`.team-row:hover{background:var(--hover);}`}</style>
    </div>
  );
}
