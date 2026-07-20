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
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  LoadingBlock,
  Spinner,
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
import { BELOW_DRAWER_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
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
import { envAccent } from "../../workspace/EnvironmentSwitcher";
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

/** Scope/role tints with no design token yet (decorative): brand ember + purple + blue. */
const SCOPE_ALL = "var(--brand)";
const SCOPE_SELECTED = "#4a9dff";
const SCOPE_TAG = "#c07bff";

/** Stable per-group dot color (decorative — no server field). */
const DOT_PALETTE = [
  "var(--brand)",
  "#c07bff",
  "#4a9dff",
  "#3fb27f",
  "#f5b544",
  "#e0607e",
];
function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length];
}

/** The six matrix columns (order + copy per the redesign header). */
const MATRIX_VERBS: {
  field: keyof Pick<
    GrantDraft,
    "canView" | "canRun" | "canEdit" | "canDelete" | "canShare" | "canCreate"
  >;
  label: string;
}[] = [
  { field: "canView", label: "view" },
  { field: "canRun", label: "run" },
  { field: "canEdit", label: "edit" },
  { field: "canDelete", label: "delete" },
  { field: "canShare", label: "Promote" },
  { field: "canCreate", label: "create" },
];

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
    field: (typeof MATRIX_VERBS)[number]["field"],
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
      <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
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
                    onClick={() => setAdding((v) => !v)}
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
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy) void createGroup();
                      if (e.key === "Escape") {
                        setAdding(false);
                        setNewName("");
                      }
                    }}
                    placeholder="Group name…"
                    style={{ ...inputStyle, padding: "7px 9px" }}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    disabled={!newName.trim()}
                    onClick={() => void createGroup()}
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
                  const on = current?.id === g.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSelected(g.id)}
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
                          {g.members.length === 1 ? "" : "s"} ·{" "}
                          {g.grants.length} grant
                          {g.grants.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ---------------- RIGHT MATRIX PANE ---------------- */}
            <div style={{ flex: 1, minWidth: 0, padding: 18 }}>
              {current ? (
                <>
                  {/* header: role-tinted icon + name + union meta + active-env pill */}
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
                          onChange={(e) =>
                            setRenaming({
                              id: current.id,
                              name: e.target.value,
                            })
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
                          {current.members.length === 1 ? "" : "s"} · grants add
                          up (union)
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
                          onClick={() =>
                            setRenaming({ id: current.id, name: current.name })
                          }
                          style={iconBtn}
                        >
                          <Icon name="edit" size={15} />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete group"
                          title="Delete group"
                          onClick={() => void deleteGroup(current)}
                          style={iconBtn}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </span>
                    )}
                  </div>

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
                        ? "var(--warning-soft, rgba(217,119,6,.12))"
                        : "var(--info-soft)",
                      color: hasAnyGrant
                        ? "var(--state-warning, #b45309)"
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
                    <div style={{ overflowX: "auto", marginBottom: 10 }}>
                      <table
                        style={{
                          minWidth: 560,
                          width: "100%",
                          borderCollapse: "collapse",
                        }}
                      >
                        <thead>
                          <tr>
                            <th style={{ ...thStyle, textAlign: "left" }}>
                              Scope target
                            </th>
                            {MATRIX_VERBS.map((v) => (
                              <th key={v.field} style={thStyle}>
                                {v.label}
                              </th>
                            ))}
                            {canManage && <th style={thStyle} />}
                          </tr>
                        </thead>
                        <tbody>
                          {current.grants.map((grant) => (
                            <tr
                              key={grant.id}
                              style={{ borderTop: "1px solid var(--line)" }}
                            >
                              <td style={{ ...tdStyle, textAlign: "left" }}>
                                <ScopeTarget
                                  grant={grant}
                                  envName={envName}
                                  wfName={wfName}
                                  tagName={tagName}
                                />
                              </td>
                              {MATRIX_VERBS.map((v) => {
                                const locked =
                                  v.field === "canCreate" &&
                                  grant.scope === "selected";
                                return (
                                  <td key={v.field} style={tdStyle}>
                                    <VerbCell
                                      on={grant[v.field]}
                                      locked={locked}
                                      touch={belowDrawer}
                                      busy={
                                        togglingCell ===
                                        `${grant.id}:${v.field}`
                                      }
                                      // Disable EVERY verb cell while any save is in flight —
                                      // togglingCell tracks a single cell, so a concurrent click
                                      // elsewhere would race and the first finally() clears busy.
                                      disabled={
                                        !canManage || togglingCell !== null
                                      }
                                      label={v.label}
                                      onToggle={() =>
                                        void toggleVerb(
                                          current.id,
                                          grant,
                                          v.field,
                                        )
                                      }
                                    />
                                  </td>
                                );
                              })}
                              {canManage && (
                                <td style={tdStyle}>
                                  <span
                                    style={{
                                      display: "flex",
                                      gap: 2,
                                      justifyContent: "flex-end",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      aria-label="Edit grant scope"
                                      title="Edit scope, targets and environment"
                                      onClick={() => {
                                        setEditorError(null);
                                        setEditor({
                                          groupId: current.id,
                                          grantId: grant.id,
                                          initial: draftFromGrant(grant),
                                        });
                                      }}
                                      style={iconBtn}
                                    >
                                      <Icon name="edit" size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="Delete grant"
                                      title="Delete grant"
                                      onClick={() =>
                                        void deleteGrant(current.id, grant)
                                      }
                                      style={iconBtn}
                                    >
                                      <Icon name="trash" size={14} />
                                    </button>
                                  </span>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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

                  {/* ---------------- MEMBERS ---------------- */}
                  <div style={{ ...sectionLabelStyle, marginTop: 22 }}>
                    Members
                  </div>
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
                          onClick={() =>
                            void removeMember(current.id, m.userId)
                          }
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
                      onChange={(e) =>
                        void addMember(current.id, e.target.value)
                      }
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
                  <div style={{ ...sectionLabelStyle, marginTop: 22 }}>
                    API tokens
                  </div>
                  <div style={{ ...mutedStyle, marginBottom: 6 }}>
                    Once this workspace has any grant, ungrouped API tokens (CI,
                    MCP, CLI) are denied everything — attach a token here to
                    give it this group&rsquo;s access.
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
                          onClick={() =>
                            void removeToken(current.id, t.tokenId)
                          }
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
                      onChange={(e) =>
                        void addToken(current.id, e.target.value)
                      }
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

/** The scope + target cell: role-tinted scope icon then mono target chips. A single
 *  'selected' grant can carry several workflow keys AND tags (all shown); a non-null
 *  environmentId is load-bearing (grants are per-env) so it rides along as a chip. */
function ScopeTarget({
  grant,
  envName,
  wfName,
  tagName,
}: {
  grant: GroupGrant;
  envName: (id: string | null) => string;
  wfName: (key: string) => string;
  tagName: (id: string) => string;
}) {
  const isAll = grant.scope === "all";
  const tint = isAll ? SCOPE_ALL : SCOPE_SELECTED;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
      <span
        style={{
          width: 22,
          height: 22,
          flex: "none",
          marginTop: 1,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          color: tint,
          background: `color-mix(in srgb, ${tint} 16%, transparent)`,
        }}
      >
        <Icon name={isAll ? "grid" : "workflow"} size={13} />
      </span>
      <span style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
        {isAll ? (
          <span style={targetChip("var(--brand)")}>All workflows</span>
        ) : (
          <>
            {grant.workflowKeys.map((k) => (
              <span
                key={`wf:${k}`}
                title={wfName(k)}
                style={targetChip(SCOPE_SELECTED)}
              >
                wf: {k}
              </span>
            ))}
            {(grant.tagIds ?? []).map((id) => (
              <span
                key={`tag:${id}`}
                title={tagName(id)}
                style={targetChip(SCOPE_TAG)}
              >
                tag: {id}
              </span>
            ))}
            {grant.workflowKeys.length === 0 &&
              (grant.tagIds ?? []).length === 0 && (
                <span style={targetChip("var(--ink-3)")}>no targets</span>
              )}
          </>
        )}
        {grant.environmentId !== null && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              alignSelf: "center",
            }}
          >
            @ {envName(grant.environmentId)}
          </span>
        )}
      </span>
    </div>
  );
}

/** One verb toggle cell: a green tap-target when on; a LOCK + disabled when `locked`
 *  (create off a selected scope). Persist happens in the parent — this is presentational
 *  plus a busy spinner. */
function VerbCell({
  on,
  locked,
  touch,
  busy,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  locked: boolean;
  touch: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  const size = touch ? 44 : 30;
  if (locked) {
    return (
      <span
        title="Create requires the All-workflows scope"
        aria-label={`${label} locked (requires All workflows)`}
        style={{
          display: "inline-grid",
          placeItems: "center",
          width: size,
          height: size,
          color: "var(--ink-3)",
          opacity: 0.5,
        }}
      >
        <LockGlyph />
      </span>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onToggle}
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        margin: "0 auto",
        padding: 0,
        borderRadius: 7,
        cursor: disabled ? "default" : "pointer",
        border: `1px solid ${on ? "var(--state-done)" : "var(--line-2)"}`,
        background: on ? "var(--state-done)" : "transparent",
        color: on ? "#fff" : "var(--ink-3)",
        opacity: busy ? 0.7 : 1,
        transition: "background .12s ease, border-color .12s ease",
      }}
    >
      {busy ? (
        <Spinner
          size={14}
          color={on ? "#fff" : "var(--ink-3)"}
          track={
            on ? "color-mix(in srgb, #fff 35%, transparent)" : "var(--line-2)"
          }
        />
      ) : (
        on && <Icon name="check" size={15} />
      )}
    </button>
  );
}

/** Small inline lock (no `lock` in the icon set). */
function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="5"
        y="11"
        width="14"
        height="9"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
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
  padding: 6,
  minWidth: 32,
  minHeight: 32,
  borderRadius: "var(--radius-sm)",
};

const railLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
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
  minHeight: 44,
  padding: "7px 0",
  borderBottom: "1px solid var(--line)",
};

const thStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  textAlign: "center",
  padding: "0 6px 8px",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 6px",
  textAlign: "center",
  verticalAlign: "middle",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
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

function targetChip(tint: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-xs)",
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    color: tint,
    background: `color-mix(in srgb, ${tint} 12%, transparent)`,
    whiteSpace: "nowrap",
  };
}
