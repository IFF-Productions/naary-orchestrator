/**
 * Left rail of the Groups two-pane layout: the "add group" control + inline create
 * input, then the workspace's groups as a selectable list (chip-wrap ≤1024). Controlled —
 * all state (adding/newName/busy/selection) lives in the parent and arrives as props.
 */
import { Button, Icon } from "../../../components";
import type { PermissionGroup } from "../../../lib/api";
import { groupColor, inputStyle } from "./groupStyles";

export function GroupsRail({
  list,
  currentId,
  canManage,
  belowDrawer,
  iconBtn,
  adding,
  newName,
  busy,
  onSelect,
  onToggleAdd,
  onCancelAdd,
  onNewNameChange,
  onCreate,
}: {
  list: PermissionGroup[];
  currentId: string | null;
  canManage: boolean;
  belowDrawer: boolean;
  iconBtn: React.CSSProperties;
  adding: boolean;
  newName: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onToggleAdd: () => void;
  onCancelAdd: () => void;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div
      style={{
        flex: belowDrawer ? "none" : "0 0 236px",
        width: belowDrawer ? "auto" : 236,
        borderRight: belowDrawer ? "none" : "1px solid var(--line)",
        borderBottom: belowDrawer ? "1px solid var(--line)" : "none",
        padding: 12,
        background: "var(--card-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 6px 8px",
        }}
      >
        <span style={railLabelStyle}>Groups</span>
        {canManage && (
          <button
            type="button"
            aria-label="Add group"
            title="Add group"
            onClick={onToggleAdd}
            style={{
              ...iconBtn,
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            value={newName}
            autoFocus
            onChange={(e) => onNewNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) onCreate();
              if (e.key === "Escape") onCancelAdd();
            }}
            placeholder="Group name…"
            style={{ ...inputStyle, padding: "7px 9px" }}
          />
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!newName.trim()}
            onClick={onCreate}
          >
            Add
          </Button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: belowDrawer ? "row" : "column",
          flexWrap: belowDrawer ? "wrap" : "nowrap",
          gap: belowDrawer ? 8 : 3,
        }}
      >
        {list.map((g) => {
          const on = currentId === g.id;
          return (
            <button
              key={g.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(g.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                minHeight: 44,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: belowDrawer
                  ? `1px solid ${on ? "var(--brand)" : "var(--line-2)"}`
                  : "1px solid transparent",
                background: on
                  ? "var(--brand-soft)"
                  : belowDrawer
                    ? "var(--card)"
                    : "transparent",
                cursor: "pointer",
                textAlign: "left",
                width: belowDrawer ? "auto" : "100%",
                transition: "background .12s ease",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  flex: "none",
                  borderRadius: "50%",
                  background: groupColor(g.id),
                }}
              />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {g.name}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  {g.members.length} member
                  {g.members.length === 1 ? "" : "s"} · {g.grants.length} grant
                  {g.grants.length === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const railLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
