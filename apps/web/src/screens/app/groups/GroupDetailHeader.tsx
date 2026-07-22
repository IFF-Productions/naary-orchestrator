/**
 * Header of the selected-group pane: role-tinted icon, group name (or inline rename
 * field), the active-environment pill (decorative context — grants are additive per env,
 * so this never filters the matrix), and the rename/delete actions. Controlled by parent.
 */
import { Button, Icon } from "../../../components";
import type { Environment, PermissionGroup } from "../../../lib/api";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";
import { groupColor, inputStyle } from "./groupStyles";

export function GroupDetailHeader({
  current,
  canManage,
  renaming,
  activeEnvObj,
  iconBtn,
  onRenameChange,
  onRenameStart,
  onRenameCancel,
  onRenameSave,
  onDelete,
}: {
  current: PermissionGroup;
  canManage: boolean;
  renaming: { id: string; name: string } | null;
  activeEnvObj: Environment | null;
  iconBtn: React.CSSProperties;
  onRenameChange: (name: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          flex: "none",
          borderRadius: "var(--radius-sm)",
          display: "grid",
          placeItems: "center",
          background: `color-mix(in srgb, ${groupColor(current.id)} 18%, transparent)`,
          color: groupColor(current.id),
        }}
      >
        <Icon name="users" size={17} />
      </span>
      {renaming?.id === current.id ? (
        <span style={{ display: "flex", gap: 8, flex: 1 }}>
          <input
            value={renaming.name}
            autoFocus
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSave();
              if (e.key === "Escape") onRenameCancel();
            }}
            style={{ ...inputStyle, maxWidth: 280 }}
          />
          <Button size="sm" variant="primary" onClick={onRenameSave}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onRenameCancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            {current.name}
          </span>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
            }}
          >
            {current.members.length} member
            {current.members.length === 1 ? "" : "s"} · grants add up (union)
          </span>
        </span>
      )}
      {activeEnvObj && (
        <span
          title="Active environment"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 9px",
            borderRadius: 999,
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: envAccent(activeEnvObj),
            background: `color-mix(in srgb, ${envAccent(activeEnvObj)} 14%, transparent)`,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: envAccent(activeEnvObj),
            }}
          />
          {activeEnvObj.name}
        </span>
      )}
      {canManage && renaming?.id !== current.id && (
        <span style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            aria-label="Rename group"
            title="Rename group"
            onClick={onRenameStart}
            style={iconBtn}
          >
            <Icon name="edit" size={15} />
          </button>
          <button
            type="button"
            aria-label="Delete group"
            title="Delete group"
            onClick={onDelete}
            style={iconBtn}
          >
            <Icon name="trash" size={15} />
          </button>
        </span>
      )}
    </div>
  );
}
