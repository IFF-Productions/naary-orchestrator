/**
 * Groups (RBAC-GROUPS.md §4/§4a/§8, slice G2): permission groups + the six-verb grant
 * matrix. Owner/admin only (the API 403s members — this screen explains instead).
 *
 * THE CLIFF (§8.6): a workspace with zero grants behaves as today; saving the FIRST
 * grant flips ALL `member` users AND ALL ungrouped API tokens to deny-by-default.
 * That save is gated behind an explicit confirm dialog with the token impact spelled
 * out — creating the first grant IS the admin's opt-in to enforcement.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  LoadingBlock,
  Tag,
} from "../../components";
import {
  api,
  type ApiTokenRow,
  type Environment,
  type GroupGrant,
  HttpError,
  type Member,
  type PermissionGroup,
  UnauthorizedError,
} from "../../lib/api";
import {
  type GrantDraft,
  draftFromGrant,
  draftToPayload,
  emptyGrantDraft,
  workspaceHasAnyGrant,
  workspaceHasAnyTagGrant,
} from "../../lib/permissions-logic";
import { invalidateMyPermissions } from "../../lib/usePermissions";
import {
  GrantEditorDialog,
  type TagOption,
  type WorkflowOption,
} from "./groups/GrantEditor";

/** The grant-editor session: which group, and (edit flow) which grant. */
interface EditorTarget {
  groupId: string;
  grantId: string | null;
  initial: GrantDraft;
}

export function Groups() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [groups, setGroups] = useState<PermissionGroup[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notAllowed, setNotAllowed] = useState(false);

  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Grant editor + the first-grant confirm (§8.6). `pendingSave` holds the draft the
  // confirm dialog is guarding; `ackRestrict` is the explicit checkbox it requires.
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<GrantDraft | null>(null);
  const [ackRestrict, setAckRestrict] = useState(false);

  const canManage = myRole === "owner" || myRole === "admin";
  const hasAnyGrant = workspaceHasAnyGrant(groups ?? []);
  const hasAnyTagGrant = workspaceHasAnyTagGrant(groups ?? []);
  // uid → email for member rows (GroupView carries uids only).
  const emailByUid = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of members)
      if (row.userId && row.email) m.set(row.userId, row.email);
    return m;
  }, [members]);
  const tokenById = useMemo(
    () => new Map(tokens.map((t) => [t.id, t])),
    [tokens],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenant(me.tenantId);
        const [
          workspaces,
          groupList,
          memberList,
          tokenList,
          envList,
          graphs,
          tagList,
        ] = await Promise.all([
          api.getMyWorkspaces().catch(() => []),
          api.listGroups(me.tenantId),
          api.listMembers(me.tenantId).catch(() => []),
          api.listApiTokens().catch(() => []),
          api.listEnvironments(me.tenantId).catch(() => []),
          api.listGraphs().catch(() => []),
          api.listTags().catch(() => []),
        ]);
        if (!live) return;
        setMyRole(
          workspaces.find((w) => w.tenantId === me.tenantId)?.role ?? null,
        );
        setGroups(groupList);
        setMembers(memberList.filter((m) => m.status === "active"));
        setTokens(tokenList);
        setEnvs(envList);
        setWorkflows(
          graphs.map((g) => ({ workflowKey: g.workflowKey, name: g.name })),
        );
        setTags(
          tagList.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        );
      } catch (e) {
        if (!live) return;
        if (e instanceof UnauthorizedError) {
          setError("Sign in to manage permission groups.");
        } else if (e instanceof HttpError && e.status === 403) {
          setNotAllowed(true);
        } else {
          setError("Could not load permission groups — try again.");
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function reload(): Promise<void> {
    if (!tenant) return;
    try {
      setGroups(await api.listGroups(tenant));
    } catch {
      /* keep the current list; the next action will surface an error */
    }
  }

  function describe(e: unknown, fallback: string): string {
    if (e instanceof UnauthorizedError)
      return "Sign in to manage permission groups.";
    if (e instanceof HttpError) return e.serverMessage ?? fallback;
    return fallback;
  }

  async function createGroup(): Promise<void> {
    if (!tenant || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.createGroup(tenant, newName.trim());
      setNewName("");
      setGroups((gs) => [...(gs ?? []), g]);
      setExpanded(g.id);
    } catch (e) {
      setError(describe(e, "Could not create the group (duplicate name?)."));
    } finally {
      setBusy(false);
    }
  }

  async function renameGroup(): Promise<void> {
    if (!tenant || !renaming || !renaming.name.trim()) return;
    setError(null);
    try {
      const g = await api.renameGroup(
        tenant,
        renaming.id,
        renaming.name.trim(),
      );
      setGroups((gs) => (gs ?? []).map((x) => (x.id === g.id ? g : x)));
      setRenaming(null);
    } catch (e) {
      setError(describe(e, "Could not rename the group (duplicate name?)."));
    }
  }

  async function deleteGroup(g: PermissionGroup): Promise<void> {
    if (!tenant) return;
    const liftsCliff =
      g.grants.length > 0 &&
      (groups ?? []).every((x) => x.id === g.id || x.grants.length === 0);
    if (
      !window.confirm(
        `Delete group "${g.name}"? Its members, attached tokens, and grants are removed.` +
          (liftsCliff
            ? " This deletes the workspace's LAST grant — members and API tokens go back to full access."
            : ""),
      )
    )
      return;
    setError(null);
    try {
      await api.deleteGroup(tenant, g.id);
      invalidateMyPermissions();
      setGroups((gs) => (gs ?? []).filter((x) => x.id !== g.id));
    } catch (e) {
      setError(describe(e, "Could not delete the group."));
    }
  }

  async function addMember(groupId: string, userId: string): Promise<void> {
    if (!tenant || !userId) return;
    setError(null);
    try {
      await api.addGroupMember(tenant, groupId, userId);
      invalidateMyPermissions();
      await reload();
    } catch (e) {
      setError(describe(e, "Could not add the member."));
    }
  }

  async function removeMember(groupId: string, userId: string): Promise<void> {
    if (!tenant) return;
    setError(null);
    try {
      await api.removeGroupMember(tenant, groupId, userId);
      invalidateMyPermissions();
      await reload();
    } catch (e) {
      setError(describe(e, "Could not remove the member."));
    }
  }

  async function addToken(groupId: string, tokenId: string): Promise<void> {
    if (!tenant || !tokenId) return;
    setError(null);
    try {
      await api.addGroupToken(tenant, groupId, tokenId);
      invalidateMyPermissions();
      const [, tokenList] = await Promise.all([
        reload(),
        api.listApiTokens().catch(() => tokens),
      ]);
      setTokens(tokenList);
    } catch (e) {
      setError(describe(e, "Could not attach the token."));
    }
  }

  async function removeToken(groupId: string, tokenId: string): Promise<void> {
    if (!tenant) return;
    setError(null);
    try {
      await api.removeGroupToken(tenant, groupId, tokenId);
      invalidateMyPermissions();
      const [, tokenList] = await Promise.all([
        reload(),
        api.listApiTokens().catch(() => tokens),
      ]);
      setTokens(tokenList);
    } catch (e) {
      setError(describe(e, "Could not detach the token."));
    }
  }

  async function deleteGrant(
    groupId: string,
    grant: GroupGrant,
  ): Promise<void> {
    if (!tenant) return;
    const isLast =
      (groups ?? []).reduce((n, g) => n + g.grants.length, 0) === 1;
    if (
      !window.confirm(
        "Delete this grant?" +
          (isLast
            ? " It is the workspace's LAST grant — members and API tokens go back to full access."
            : ""),
      )
    )
      return;
    setError(null);
    try {
      await api.deleteGrant(tenant, groupId, grant.id);
      invalidateMyPermissions();
      await reload();
    } catch (e) {
      setError(describe(e, "Could not delete the grant."));
    }
  }

  /** Save from the editor dialog. A NEW grant in a zero-grant workspace routes through
   *  the first-grant confirm (§4/§8.6) instead of saving straight away. */
  function requestSave(draft: GrantDraft): void {
    if (!editor) return;
    if (editor.grantId === null && !hasAnyGrant) {
      setAckRestrict(false);
      setPendingSave(draft);
      return;
    }
    void persistGrant(draft);
  }

  async function persistGrant(draft: GrantDraft): Promise<void> {
    if (!tenant || !editor) return;
    setEditorBusy(true);
    setEditorError(null);
    try {
      const payload = draftToPayload(draft);
      if (editor.grantId === null) {
        await api.createGrant(tenant, editor.groupId, payload);
      } else {
        await api.updateGrant(tenant, editor.groupId, editor.grantId, payload);
      }
      invalidateMyPermissions();
      setEditor(null);
      setPendingSave(null);
      await reload();
    } catch (e) {
      setPendingSave(null);
      setEditorError(describe(e, "Could not save the grant."));
    } finally {
      setEditorBusy(false);
    }
  }

  const envName = (id: string | null): string =>
    id === null
      ? "All environments"
      : (envs.find((e) => e.id === id)?.name ?? "Deleted environment");

  const grantVerbs = (g: GroupGrant): string[] => {
    const on: string[] = [];
    if (g.canView) on.push("view");
    if (g.canRun) on.push("run");
    if (g.canEdit) on.push("edit");
    if (g.canDelete) on.push("delete");
    if (g.canShare) on.push("promote");
    if (g.canCreate) on.push("create");
    return on;
  };

  if (notAllowed) {
    return (
      <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
        <EmptyState
          icon="key"
          title="Owner or admin only"
          body="Permission groups control what workspace members and API tokens can do. Ask a workspace owner or admin to manage them."
        />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "22px 28px 40px",
        maxWidth: 1080,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            letterSpacing: "var(--tracking-tight)",
            color: "var(--ink)",
          }}
        >
          Groups
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginTop: 2,
          }}
        >
          {hasAnyGrant ? (
            <>
              <strong style={{ color: "var(--ink)" }}>Enforcement is on</strong>
              {
                " — members and API tokens only get what their groups grant; anyone ungrouped is denied."
              }
            </>
          ) : (
            "No grants yet — every member and API token has full access. Saving the first grant switches this workspace to deny-by-default."
          )}
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "9px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--error-soft)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {/* create group — owner/admin only (server-enforced; hidden otherwise, like Team) */}
      {canManage && (
        <Card style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void createGroup();
              }}
              placeholder="New group name (e.g. Support engineers)"
              style={inputStyle}
            />
            <Button
              variant="primary"
              icon="plus"
              loading={busy}
              disabled={!newName.trim()}
              onClick={() => void createGroup()}
            >
              Create group
            </Button>
          </div>
        </Card>
      )}

      {groups === null && !error && <LoadingBlock label="Loading groups…" />}

      {groups?.length === 0 && (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="key"
            title="No permission groups yet"
            body="Groups scope what workspace members and API tokens can see and do, per environment. Until a group holds a grant, everyone keeps full access."
          />
        </Card>
      )}

      {groups?.map((g) => {
        const open = expanded === g.id;
        const memberIds = new Set(g.members.map((m) => m.userId));
        const tokenIds = new Set(g.tokens.map((t) => t.tokenId));
        const addableMembers = members.filter(
          (m) => m.userId && !memberIds.has(m.userId),
        );
        const addableTokens = tokens.filter((t) => !tokenIds.has(t.id));
        return (
          <Card key={g.id} style={{ padding: 0, marginBottom: 12 }}>
            {/* header row */}
            <div
              onClick={() => setExpanded(open ? null : g.id)}
              className="run-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 16px",
                cursor: "pointer",
                // Keep the hover tint inside the Card's rounded corners.
                borderRadius: open
                  ? "var(--radius-lg) var(--radius-lg) 0 0"
                  : "var(--radius-lg)",
              }}
            >
              <Icon
                name="chevron-down"
                size={15}
                style={{
                  color: "var(--ink-3)",
                  transform: open ? "none" : "rotate(-90deg)",
                  transition: "transform .14s ease",
                }}
              />
              {renaming?.id === g.id ? (
                <span
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: "flex", gap: 8, flex: 1 }}
                >
                  <input
                    value={renaming.name}
                    autoFocus
                    onChange={(e) =>
                      setRenaming({ id: g.id, name: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void renameGroup();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    style={{ ...inputStyle, maxWidth: 280 }}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void renameGroup()}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {g.name}
                </span>
              )}
              <span style={countStyle}>
                {g.members.length} member{g.members.length === 1 ? "" : "s"}
              </span>
              <span style={countStyle}>
                {g.tokens.length} token{g.tokens.length === 1 ? "" : "s"}
              </span>
              <span style={countStyle}>
                {g.grants.length} grant{g.grants.length === 1 ? "" : "s"}
              </span>
              {canManage && renaming?.id !== g.id && (
                <span
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: "flex", gap: 4 }}
                >
                  <button
                    type="button"
                    aria-label="Rename group"
                    title="Rename group"
                    onClick={() => setRenaming({ id: g.id, name: g.name })}
                    style={iconBtnStyle}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete group"
                    title="Delete group"
                    onClick={() => void deleteGroup(g)}
                    style={iconBtnStyle}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              )}
            </div>

            {open && (
              <div
                style={{
                  borderTop: "1px solid var(--line)",
                  padding: 16,
                  animation: "naaryFadeUp .2s ease",
                }}
              >
                {/* -------- members -------- */}
                <div style={sectionLabelStyle}>Members</div>
                {g.members.length === 0 && (
                  <div style={mutedStyle}>No members in this group yet.</div>
                )}
                {g.members.map((m) => (
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
                        onClick={() => void removeMember(g.id, m.userId)}
                        style={iconBtnStyle}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {canManage && addableMembers.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => void addMember(g.id, e.target.value)}
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

                {/* -------- API tokens (§4a) -------- */}
                <div style={{ ...sectionLabelStyle, marginTop: 18 }}>
                  API tokens
                </div>
                <div style={{ ...mutedStyle, marginBottom: 6 }}>
                  Once this workspace has any grant, ungrouped API tokens (CI,
                  MCP, CLI) are denied everything — attach a token here to give
                  it this group&rsquo;s access.
                </div>
                {g.tokens.map((t) => (
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
                        onClick={() => void removeToken(g.id, t.tokenId)}
                        style={iconBtnStyle}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {canManage && addableTokens.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => void addToken(g.id, e.target.value)}
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
                    No API tokens in this workspace (mint them under
                    Integrations → MCP access).
                  </div>
                )}

                {/* -------- grants -------- */}
                <div style={{ ...sectionLabelStyle, marginTop: 18 }}>
                  Grants
                </div>
                {g.grants.length === 0 && (
                  <div style={mutedStyle}>
                    No grants — this group gives its members and tokens nothing
                    yet.
                  </div>
                )}
                {g.grants.map((grant) => (
                  <div key={grant.id} style={{ ...rowStyle, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: "var(--weight-medium)",
                        color: "var(--ink)",
                      }}
                    >
                      {envName(grant.environmentId)}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {grant.scope === "all"
                        ? "all workflows"
                        : `${grant.workflowKeys.length} workflow${grant.workflowKeys.length === 1 ? "" : "s"}` +
                          ((grant.tagIds ?? []).length > 0
                            ? ` + ${grant.tagIds.length} tag${grant.tagIds.length === 1 ? "" : "s"}`
                            : "")}
                    </span>
                    <span
                      style={{
                        display: "flex",
                        gap: 4,
                        flexWrap: "wrap",
                        flex: 1,
                      }}
                    >
                      {grantVerbs(grant).map((v) => (
                        <Tag key={v}>{v}</Tag>
                      ))}
                    </span>
                    {canManage && (
                      <span style={{ display: "flex", gap: 6 }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setEditorError(null);
                            setEditor({
                              groupId: g.id,
                              grantId: grant.id,
                              initial: draftFromGrant(grant),
                            });
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void deleteGrant(g.id, grant)}
                        >
                          Delete
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
                {canManage && (
                  <div style={{ marginTop: 8 }}>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="plus"
                      onClick={() => {
                        setEditorError(null);
                        setEditor({
                          groupId: g.id,
                          grantId: null,
                          initial: emptyGrantDraft(),
                        });
                      }}
                    >
                      Add grant
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {/* grant editor — keyed so a new target reseeds the local draft */}
      {editor && (
        <GrantEditorDialog
          key={`${editor.groupId}:${editor.grantId ?? "new"}`}
          open
          title={editor.grantId ? "Edit grant" : "Add grant"}
          initial={editor.initial}
          envs={envs}
          workflows={workflows}
          tags={tags}
          tagGrantsExist={hasAnyTagGrant}
          busy={editorBusy}
          error={editorError}
          onSave={requestSave}
          onClose={() => setEditor(null)}
        />
      )}

      {/* THE FIRST-GRANT WARNING (§4/§8.6) — explicit opt-in to deny-by-default */}
      <Dialog
        open={pendingSave !== null}
        onClose={() => setPendingSave(null)}
        title="This restricts your whole workspace"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingSave(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!ackRestrict || editorBusy}
              loading={editorBusy}
              onClick={() => pendingSave && void persistGrant(pendingSave)}
            >
              Save first grant
            </Button>
          </>
        }
      >
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink)",
            lineHeight: "var(--leading-snug)",
            marginBottom: 12,
          }}
        >
          This is the workspace&rsquo;s <strong>first grant</strong>. Saving it
          switches every <strong>member</strong> and every{" "}
          <strong>API token</strong> to deny-by-default — from then on they can
          only do what their groups grant.
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: "var(--leading-snug)",
            marginBottom: 12,
          }}
        >
          {tokens.length > 0 ? (
            <>
              This workspace has{" "}
              <strong>
                {tokens.length} API token{tokens.length === 1 ? "" : "s"}
              </strong>{" "}
              (CI, MCP, CLI). Ungrouped tokens <strong>stop working</strong>{" "}
              until you attach them to a group — use the &ldquo;API
              tokens&rdquo; picker on the group after saving.
            </>
          ) : (
            "This workspace has no API tokens, so only members are affected."
          )}{" "}
          Owners and admins are never restricted, and
          scheduled/webhook-triggered runs keep working.
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 9,
            fontSize: "var(--text-sm)",
            color: "var(--ink)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={ackRestrict}
            onChange={(e) => setAckRestrict(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            I understand this restricts all members and all API tokens, and that
            ungrouped tokens will stop working until they are added to a group.
          </span>
        </label>
      </Dialog>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};

const iconBtnStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--ink-3)",
  padding: 4,
};

const countStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
  whiteSpace: "nowrap",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginBottom: 6,
};

const mutedStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 0",
  borderBottom: "1px solid var(--line)",
};
