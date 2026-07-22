/**
 * The selected group's people + machines: workspace members in the group, and (§4a) the
 * API tokens attached to it. Once the workspace has any grant, ungrouped tokens are denied
 * everything, so attaching a token here is how it regains this group's access. Controlled.
 */
import { Icon } from "../../../components";
import type { ApiTokenRow, Member, PermissionGroup } from "../../../lib/api";
import { inputStyle, mutedStyle, sectionLabelStyle } from "./groupStyles";

export function GroupMembersPanel({
  current,
  canManage,
  emailByUid,
  tokenById,
  addableMembers,
  addableTokens,
  tokens,
  iconBtn,
  onAddMember,
  onRemoveMember,
  onAddToken,
  onRemoveToken,
}: {
  current: PermissionGroup;
  canManage: boolean;
  emailByUid: Map<string, string>;
  tokenById: Map<string, ApiTokenRow>;
  addableMembers: Member[];
  addableTokens: ApiTokenRow[];
  tokens: ApiTokenRow[];
  iconBtn: React.CSSProperties;
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
  onAddToken: (tokenId: string) => void;
  onRemoveToken: (tokenId: string) => void;
}) {
  return (
    <>
      {/* ---------------- MEMBERS ---------------- */}
      <div style={{ ...sectionLabelStyle, marginTop: 22 }}>Members</div>
      {current.members.length === 0 && (
        <div style={mutedStyle}>No members in this group yet.</div>
      )}
      {current.members.map((m) => (
        <div key={m.userId} style={rowStyle}>
          <span
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              color: "var(--ink)",
            }}
          >
            {emailByUid.get(m.userId) ?? m.userId}
          </span>
          {canManage && (
            <button
              type="button"
              aria-label="Remove from group"
              onClick={() => onRemoveMember(m.userId)}
              style={iconBtn}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      ))}
      {canManage && addableMembers.length > 0 && (
        <select
          value=""
          onChange={(e) => onAddMember(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320, marginTop: 6 }}
        >
          <option value="">Add a workspace member…</option>
          {addableMembers.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.email || m.userId}
            </option>
          ))}
        </select>
      )}

      {/* ---------------- API tokens (§4a) ---------------- */}
      <div style={{ ...sectionLabelStyle, marginTop: 22 }}>API tokens</div>
      <div style={{ ...mutedStyle, marginBottom: 6 }}>
        Once this workspace has any grant, ungrouped API tokens (CI, MCP, CLI)
        are denied everything — attach a token here to give it this
        group&rsquo;s access.
      </div>
      {current.tokens.map((t) => (
        <div key={t.tokenId} style={rowStyle}>
          <span
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              color: "var(--ink)",
            }}
          >
            {tokenById.get(t.tokenId)?.label ?? t.tokenId}
          </span>
          {canManage && (
            <button
              type="button"
              aria-label="Detach token"
              onClick={() => onRemoveToken(t.tokenId)}
              style={iconBtn}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      ))}
      {canManage && addableTokens.length > 0 && (
        <select
          value=""
          onChange={(e) => onAddToken(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320, marginTop: 6 }}
        >
          <option value="">Attach an API token…</option>
          {addableTokens.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {tokens.length === 0 && (
        <div style={mutedStyle}>
          No API tokens in this workspace (mint them under Integrations → MCP
          access).
        </div>
      )}
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 44,
  padding: "7px 0",
  borderBottom: "1px solid var(--line)",
};
