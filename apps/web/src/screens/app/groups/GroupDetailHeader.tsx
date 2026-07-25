/**
 * Header of the selected-group pane: role-tinted icon, group name (or inline rename
 * field), the active-environment pill (decorative context — grants are additive per env,
 * so this never filters the matrix), and the rename/delete actions. Controlled by parent.
 */
import { Button, Icon } from "../../../components";
import type { Environment, PermissionGroup } from "../../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
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
  // Phone (#511): `flexWrap` alone wasn't enough here — the 34px icon, the env pill and
  // the two icon buttons are all `flex: none`, so at 390px they stayed on the first line
  // and squeezed the name/meta column to ~120px, wrapping "Finance approvers" and
  // "2 members · grants add up (union)" over five lines. Stack the title block above the
  // pill + actions onto a second row instead (the wave's header-collapse idiom, e.g.
  // Runs.tsx) — icon + name stay together on the first row, so nothing is orphaned.
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: phone ? "column" : "row",
        alignItems: phone ? "stretch" : "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      {/* Row 1 on phone: the group mark + its name/meta (or the inline rename field). */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: phone ? "none" : 1,
          minWidth: 0,
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
      </span>
      {/* Row 2 on phone: the decorative env pill + the rename/delete actions. */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: "none",
          flexWrap: "wrap",
        }}
      >
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
      </span>
    </div>
  );
}
