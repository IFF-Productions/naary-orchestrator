import { Button, Card, Icon, Table } from "../../components";
import { members, ROLE_COLOR, type MemberRow } from "../../lib/mock";

/* Team — ported from Naary.dc.html (lines 439–458). Members, roles and
   approval permissions. Role badges use ROLE_COLOR (Owner=brand, Admin=info,
   Member=ink-2, Viewer=ink-3) over a matching soft tint, mirroring the DC
   `rolePill`. */

function RolePill({ member }: { member: MemberRow }) {
  const color = ROLE_COLOR[member.role];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        padding: "3px 10px",
        borderRadius: 20,
      }}
    >
      {member.role}
    </span>
  );
}

export function Team() {
  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
      {/* heading + invite */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 21,
              fontWeight: 700,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Team
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            12 members · roles control who can approve paused runs.
          </div>
        </div>
        <Button variant="primary" icon="plus">
          Invite member
        </Button>
      </div>

      {/* members table */}
      <Card pad={false} style={{ overflow: "hidden" }}>
        <Table<MemberRow>
          rowKey={(m) => m.email}
          columns={[
            {
              key: "member",
              header: "Member",
              width: "36%",
              render: (m) => (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: m.av,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#fff",
                      flex: "none",
                    }}
                  >
                    {m.initials}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: "var(--ink)",
                      }}
                    >
                      {m.name}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                    >
                      {m.email}
                    </div>
                  </div>
                </div>
              ),
            },
            {
              key: "role",
              header: "Role",
              width: "16%",
              render: (m) => <RolePill member={m} />,
            },
            {
              key: "approve",
              header: "Can approve",
              width: "22%",
              render: (m) => (
                <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                  {m.approve}
                </span>
              ),
            },
            {
              key: "active",
              header: "Last active",
              width: "16%",
              render: (m) => (
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  {m.active}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              width: 40,
              render: () => (
                <button
                  aria-label="Member actions"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    border: "none",
                    background: "transparent",
                    color: "var(--ink-3)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="more" size={15} />
                </button>
              ),
            },
          ]}
          rows={members}
        />
      </Card>
    </div>
  );
}
