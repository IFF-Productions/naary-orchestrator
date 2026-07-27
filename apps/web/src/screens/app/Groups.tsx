/**
 * Groups (RBAC-GROUPS.md §4/§4a/§8, slice G2): permission groups + the six-verb grant
 * matrix. Owner/admin only (the API 403s members — this screen explains instead).
 *
 * Redesign "1a — two-pane matrix table": a left rail lists the workspace's groups; the
 * right pane is the selected group's grant MATRIX — one row per grant, six verb cells
 * toggled inline. Toggling persists through the SAME grant API the dialog uses
 * (draftFromGrant → flip one verb → draftToPayload → api.updateGrant), so the render is
 * a restyle over the existing logic — no new data flow, no client-only state.
 *
 * THE CLIFF (§8.6): a workspace with zero grants behaves as today; saving the FIRST
 * grant flips ALL `member` users AND ALL ungrouped API tokens to deny-by-default. The
 * enforcement switch IS grant existence in the workspace (§9), so the banner reads the
 * real state from `workspaceHasAnyGrant` — it is not a simulated toggle. That first save
 * is gated behind an explicit confirm dialog with the token impact spelled out.
 *
 * This file is the container: it owns all state, the load effect, and the grant/group
 * handlers, and composes the presentational panels under ./groups/*.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingBlock,
  useConfirm,
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
import { useActiveEnvironment } from "../../lib/useActiveEnvironment";
import {
  BELOW_DRAWER_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../../lib/useMediaQuery";
import {
  type GrantDraft,
  draftFromGrant,
  draftProblem,
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
import { FirstGrantDialog } from "./groups/FirstGrantDialog";
import { GrantMatrixTable } from "./groups/GrantMatrixTable";
import { GroupDetailHeader } from "./groups/GroupDetailHeader";
import { GroupMembersPanel } from "./groups/GroupMembersPanel";
import { GroupsRail } from "./groups/GroupsRail";
import {
  type MatrixVerbField,
  SCOPE_ALL,
  SCOPE_SELECTED,
  SCOPE_TAG,
  mutedStyle,
  sectionLabelStyle,
} from "./groups/groupStyles";

/** The grant-editor session: which group, and (edit flow) which grant. */
interface EditorTarget {
  groupId: string;
  grantId: string | null;
  initial: GrantDraft;
}

export function Groups() {
  const confirm = useConfirm();
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
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  // Which verb cell is mid-save (`grantId:field`) — a per-cell spinner instead of
  // optimistic local state (which could desync from the real grant).
  const [togglingCell, setTogglingCell] = useState<string | null>(null);

  // Grant editor + the first-grant confirm (§8.6). `pendingSave` holds the draft the
  // confirm dialog is guarding; `ackRestrict` is the explicit checkbox it requires.
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<GrantDraft | null>(null);
  const [ackRestrict, setAckRestrict] = useState(false);

  const belowDrawer = useMediaQuery(BELOW_DRAWER_QUERY);
  // Phone gutters (#511): this screen collapsed its two panes at <= 1024 but never
  // reduced the desktop 28px page padding (+18px pane padding) for a 390px phone.
  const phone = useMediaQuery(PHONE_QUERY);
  const activeEnv = useActiveEnvironment();

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

  // The selected group, resolved once (falls back to the first group).
  const current = useMemo(
    () =>
      (groups ?? []).find((g) => g.id === selected) ??
      (groups ?? [])[0] ??
      null,
    [groups, selected],
  );
  // Precompute the add-member / attach-token candidates ONCE per selected group,
  // instead of rebuilding `new Set(...)` + filtering twice inside each dropdown.
  const addableMembers = useMemo(() => {
    if (!current) return [];
    const inGroup = new Set(current.members.map((m) => m.userId));
    return members.filter((m) => m.userId && !inGroup.has(m.userId));
  }, [current, members]);
  const addableTokens = useMemo(() => {
    if (!current) return [];
    const attached = new Set(current.tokens.map((t) => t.tokenId));
    return tokens.filter((t) => !attached.has(t.id));
  }, [current, tokens]);

  // The active environment resolved to a pill (decorative context for the pane header).
  // Grants are additive per environment, so this NEVER filters the matrix — see below.
  const activeEnvObj = useMemo(
    () => envs.find((e) => e.id === activeEnv || e.slug === activeEnv) ?? null,
    [envs, activeEnv],
  );

  // ≥44px touch targets where a finger taps (≤1024); stay compact on desktop.
  const touchMin = belowDrawer ? 44 : 32;
  const iconBtn: React.CSSProperties = {
    ...iconBtnStyle,
    minWidth: touchMin,
    minHeight: touchMin,
  };

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
        setSelected(groupList[0]?.id ?? null);
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
      setAdding(false);
      setGroups((gs) => [...(gs ?? []), g]);
      setSelected(g.id);
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
    const ok = await confirm({
      title: `Delete group "${g.name}"?`,
      body:
        "Its members, attached tokens, and grants are removed." +
        (liftsCliff
          ? " This deletes the workspace's LAST grant — members and API tokens go back to full access."
          : ""),
      confirmLabel: "Delete group",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.deleteGroup(tenant, g.id);
      invalidateMyPermissions();
      setGroups((gs) => (gs ?? []).filter((x) => x.id !== g.id));
      setSelected((cur) => (cur === g.id ? null : cur));
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
    const ok = await confirm({
      title: "Delete this grant?",
      body: isLast
        ? "It is the workspace's LAST grant — members and API tokens go back to full access."
        : undefined,
      confirmLabel: "Delete grant",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.deleteGrant(tenant, groupId, grant.id);
      invalidateMyPermissions();
      await reload();
    } catch (e) {
      setError(describe(e, "Could not delete the grant."));
    }
  }

  /**
   * Inline verb toggle on an EXISTING grant. Reuses the dialog's exact save path —
   * seed the draft from the grant, flip one verb, normalize via draftToPayload, PATCH.
   * Blocking a toggle that would zero the grant's verbs mirrors the dialog's disabled
   * Save (draftProblem) — it is the same policy, not a new one. No first-grant confirm:
   * the grant already exists, so the cliff has already been crossed (or never will be
   * here). canManage-gated; the server also 403s a forced request.
   */
  async function toggleVerb(
    groupId: string,
    grant: GroupGrant,
    field: MatrixVerbField,
  ): Promise<void> {
    if (!tenant || !canManage) return;
    // §8.3: create is coherent only on 'all'-scope grants.
    if (field === "canCreate" && grant.scope === "selected") return;
    const next = { ...draftFromGrant(grant), [field]: !grant[field] };
    const problem = draftProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setTogglingCell(`${grant.id}:${field}`);
    try {
      await api.updateGrant(tenant, groupId, grant.id, draftToPayload(next));
      invalidateMyPermissions();
      await reload();
    } catch (e) {
      setError(describe(e, "Could not update the grant."));
    } finally {
      setTogglingCell(null);
    }
  }

  function openEditor(groupId: string, seed: GrantDraft): void {
    setEditorError(null);
    setEditor({ groupId, grantId: null, initial: seed });
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

  const wfName = (key: string): string =>
    workflows.find((w) => w.workflowKey === key)?.name ?? key;
  const tagName = (id: string): string =>
    tags.find((t) => t.id === id)?.name ?? id;

  if (notAllowed) {
    return (
      <div
        style={{
          padding: phone ? "16px 14px 32px" : "22px 28px 40px",
          maxWidth: 1080,
        }}
      >
        <EmptyState
          icon="key"
          title="Owner or admin only"
          body="Permission groups control what workspace members and API tokens can do. Ask a workspace owner or admin to manage them."
        />
      </div>
    );
  }

  const list = groups ?? [];

  return (
    <div
      style={{
        padding: phone ? "16px 14px 32px" : "22px 28px 40px",
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

      {groups === null && !error && <LoadingBlock label="Loading groups…" />}

      {groups?.length === 0 && !adding && (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="key"
            title="No permission groups yet"
            body="Groups scope what workspace members and API tokens can see and do, per environment. Until a group holds a grant, everyone keeps full access."
            action={
              canManage ? (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => setAdding(true)}
                >
                  New group
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {groups && (groups.length > 0 || adding) && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              flexDirection: belowDrawer ? "column" : "row",
              alignItems: "stretch",
            }}
          >
            {/* ---------------- LEFT RAIL (chip-wrap ≤1024) ---------------- */}
            <GroupsRail
              list={list}
              currentId={current?.id ?? null}
              canManage={canManage}
              belowDrawer={belowDrawer}
              iconBtn={iconBtn}
              adding={adding}
              newName={newName}
              busy={busy}
              onSelect={setSelected}
              onToggleAdd={() => setAdding((v) => !v)}
              onCancelAdd={() => {
                setAdding(false);
                setNewName("");
              }}
              onNewNameChange={setNewName}
              onCreate={() => void createGroup()}
            />

            {/* ---------------- RIGHT MATRIX PANE ---------------- */}
            <div
              style={{ flex: 1, minWidth: 0, padding: phone ? 12 : 18 }}
            >
              {current ? (
                <>
                  {/* header: role-tinted icon + name + union meta + active-env pill */}
                  <GroupDetailHeader
                    current={current}
                    canManage={canManage}
                    renaming={renaming}
                    activeEnvObj={activeEnvObj}
                    iconBtn={iconBtn}
                    onRenameChange={(name) =>
                      setRenaming({ id: current.id, name })
                    }
                    onRenameStart={() =>
                      setRenaming({ id: current.id, name: current.name })
                    }
                    onRenameCancel={() => setRenaming(null)}
                    onRenameSave={() => void renameGroup()}
                    onDelete={() => void deleteGroup(current)}
                  />

                  {/* CLIFF banner — bound to REAL workspace state (grant existence §9) */}
                  <div
                    style={{
                      marginTop: 14,
                      padding: "10px 12px",
                      borderRadius: "var(--radius-sm)",
                      display: "flex",
                      gap: 9,
                      alignItems: "flex-start",
                      fontSize: "var(--text-sm)",
                      lineHeight: "var(--leading-snug)",
                      background: hasAnyGrant
                        ? "var(--paused-soft)"
                        : "var(--info-soft)",
                      color: hasAnyGrant
                        ? "var(--state-paused)"
                        : "var(--ink-2)",
                    }}
                  >
                    <Icon
                      name={hasAnyGrant ? "alert" : "info"}
                      size={15}
                      style={{ marginTop: 1, flex: "none" }}
                    />
                    <span>
                      {hasAnyGrant ? (
                        <>
                          <strong>Deny-by-default active.</strong> The
                          workspace&rsquo;s first grant flipped all members and
                          all ungrouped API tokens to deny — they now get only
                          what their groups grant. (Removing every grant returns
                          the workspace to implicit-allow.)
                        </>
                      ) : (
                        <>
                          <strong>Implicit allow.</strong> With zero grants,
                          every member and API token has full access. Saving the
                          first grant switches this whole workspace to
                          deny-by-default.
                        </>
                      )}
                    </span>
                  </div>

                  {/* ---------------- MATRIX TABLE ---------------- */}
                  <div style={{ ...sectionLabelStyle, marginTop: 18 }}>
                    Grants
                  </div>
                  {current.grants.length === 0 ? (
                    <div style={{ ...mutedStyle, marginBottom: 10 }}>
                      No grants — this group gives its members and tokens
                      nothing yet. Add one below.
                    </div>
                  ) : (
                    <GrantMatrixTable
                      grants={current.grants}
                      canManage={canManage}
                      belowDrawer={belowDrawer}
                      togglingCell={togglingCell}
                      envName={envName}
                      wfName={wfName}
                      tagName={tagName}
                      onToggleVerb={(grant, field) =>
                        void toggleVerb(current.id, grant, field)
                      }
                      onEditGrant={(grant) => {
                        setEditorError(null);
                        setEditor({
                          groupId: current.id,
                          grantId: grant.id,
                          initial: draftFromGrant(grant),
                        });
                      }}
                      onDeleteGrant={(grant) =>
                        void deleteGrant(current.id, grant)
                      }
                      iconBtn={iconBtn}
                    />
                  )}

                  {/* add-grant pills — reuse the existing GrantEditorDialog flow */}
                  {canManage && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--ink-3)",
                          fontWeight: "var(--weight-semibold)",
                        }}
                      >
                        Add grant scope:
                      </span>
                      <button
                        type="button"
                        style={pillStyle(SCOPE_ALL, belowDrawer)}
                        onClick={() =>
                          openEditor(current.id, {
                            ...emptyGrantDraft(),
                            scope: "all",
                          })
                        }
                      >
                        All workflows
                      </button>
                      <button
                        type="button"
                        style={pillStyle(SCOPE_SELECTED, belowDrawer)}
                        onClick={() =>
                          openEditor(current.id, {
                            ...emptyGrantDraft(),
                            scope: "selected",
                          })
                        }
                      >
                        Pick workflows…
                      </button>
                      <button
                        type="button"
                        style={pillStyle(SCOPE_TAG, belowDrawer)}
                        onClick={() =>
                          openEditor(current.id, {
                            ...emptyGrantDraft(),
                            scope: "selected",
                          })
                        }
                      >
                        Pick tags…
                      </button>
                    </div>
                  )}

                  {/* footnote */}
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                      lineHeight: "var(--leading-snug)",
                    }}
                  >
                    A grant needs at least one permission (and, for a selected
                    scope, at least one workflow or tag). Create is only
                    available on All workflows. A tag grant auto-covers current
                    and future workflows carrying that tag.
                  </div>

                  {/* ---------------- MEMBERS + API tokens (§4a) ---------------- */}
                  <GroupMembersPanel
                    current={current}
                    canManage={canManage}
                    emailByUid={emailByUid}
                    tokenById={tokenById}
                    addableMembers={addableMembers}
                    addableTokens={addableTokens}
                    tokens={tokens}
                    iconBtn={iconBtn}
                    onAddMember={(userId) => void addMember(current.id, userId)}
                    onRemoveMember={(userId) =>
                      void removeMember(current.id, userId)
                    }
                    onAddToken={(tokenId) => void addToken(current.id, tokenId)}
                    onRemoveToken={(tokenId) =>
                      void removeToken(current.id, tokenId)
                    }
                  />
                </>
              ) : (
                <EmptyState
                  icon="key"
                  title="Select a group"
                  body="Pick a group on the left to edit its grant matrix, members and tokens."
                />
              )}
            </div>
          </div>
        </Card>
      )}

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
      <FirstGrantDialog
        open={pendingSave !== null}
        tokenCount={tokens.length}
        ackRestrict={ackRestrict}
        busy={editorBusy}
        onAckChange={setAckRestrict}
        onCancel={() => setPendingSave(null)}
        onConfirm={() => pendingSave && void persistGrant(pendingSave)}
      />
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--ink-3)",
  padding: 6,
  minWidth: 32,
  minHeight: 32,
  borderRadius: "var(--radius-sm)",
};

function pillStyle(tint: string, touch: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    minHeight: touch ? 44 : 32,
    padding: touch ? "10px 14px" : "6px 12px",
    borderRadius: 999,
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    color: tint,
    background: `color-mix(in srgb, ${tint} 12%, transparent)`,
    border: `1px solid color-mix(in srgb, ${tint} 40%, transparent)`,
  };
}
