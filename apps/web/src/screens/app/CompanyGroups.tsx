// Company-wide permission groups (RBAC-GROUPS §9): owner-only card on the company console.
// A group's grant applies to ALL workflows in ALL attached workspaces, every environment —
// and only ADDS access back for members a workspace has already restricted via its own
// first-grant cliff; it never restricts anyone. uid-keyed only (no API tokens).
//
// Layout follows the redesign's "Naary CompanyGroups.dc.html" rail + grant-matrix comp, wired to
// the v1 backend (a SINGLE all-workflows grant per group). The comp additionally sketches
// multiple grants, tag/workflow scope targets, per-workspace "Applies to" selection, and a
// company-wide deny-by-default cliff toggle — NONE of which the v1 CompanyGroupGrant supports
// (and the comp's cliff copy is the inverse of the real additive-only semantics). Those are
// intentionally NOT rendered here; see the PR notes. We show what actually persists.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Spinner, TextInput } from "../../components";
import {
  api,
  type CompanyGroup,
  type CompanyGroupGrant,
  type CompanyMember,
} from "../../lib/api";
import { BELOW_DRAWER_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

const VERBS = [
  { key: "canView", label: "View" },
  { key: "canRun", label: "Run" },
  { key: "canEdit", label: "Edit" },
  { key: "canDelete", label: "Delete" },
  { key: "canShare", label: "Promote" },
  { key: "canCreate", label: "Create" },
] as const;

type VerbKey = (typeof VERBS)[number]["key"];
type VerbSet = Record<VerbKey, boolean>;

const NO_VERBS: VerbSet = {
  canView: false,
  canRun: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
  canCreate: false,
};

// Decorative dot hues per group (scannability in the rail), cycled by index. The first is the
// brand token; the rest are redesign role hues that read on both themes. Purely cosmetic —
// v1 company groups carry no "role".
const DOTS = ["var(--brand)", "#c07bff", "#4a9dff", "#2fb8c9", "#7c8798"];

function verbsOf(grant: CompanyGroupGrant | null): VerbSet {
  if (!grant) return { ...NO_VERBS };
  const set = { ...NO_VERBS };
  for (const v of VERBS) set[v.key] = grant[v.key];
  return set;
}

/** Owner-only Groups card for the company console (rendered by Company.tsx). */
export function CompanyGroupsCard({ companyId }: { companyId: string }) {
  const compact = useMediaQuery(BELOW_DRAWER_QUERY);
  const [groups, setGroups] = useState<CompanyGroup[] | null>(null);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setGroups(await api.listCompanyGroups(companyId));
  }, [companyId]);

  useEffect(() => {
    let live = true;
    setGroups(null);
    setSelId(null);
    setErr(null);
    api
      .listCompanyGroups(companyId)
      .then((g) => live && setGroups(g))
      .catch(() => live && setErr("Couldn't load the company groups."));
    api
      .listCompanyMembers(companyId)
      .then((m) => live && setMembers(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [companyId]);

  // Keep a selection: default to the first group; drop it if the selected group is gone.
  useEffect(() => {
    if (!groups) return;
    if (selId && groups.some((g) => g.id === selId)) return;
    setSelId(groups[0]?.id ?? null);
  }, [groups, selId]);

  const selected = useMemo(
    () => groups?.find((g) => g.id === selId) ?? null,
    [groups, selId],
  );
  const selIndex = useMemo(
    () => groups?.findIndex((g) => g.id === selId) ?? -1,
    [groups, selId],
  );

  async function create() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const g = await api.createCompanyGroup(companyId, newName.trim());
      setNewName("");
      await reload();
      setSelId(g.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setErr(
        msg.includes("→ 409")
          ? "A group with that name already exists."
          : "Couldn't create the group.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
      {/* header */}
      <div
        style={{
          padding: "16px 18px 14px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ fontWeight: "var(--weight-semibold)", marginBottom: 4 }}>
          Permission groups
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          Company-wide access for restricted members. A group's permissions
          apply to ALL workflows in ALL attached workspaces, every environment —
          and only <b>add</b> access back where a workspace already restricts
          its members (its own first-grant cliff). They never restrict anyone;
          an unrestricted workspace is unaffected.
        </div>
        {err && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              marginTop: 8,
            }}
          >
            {err}
          </div>
        )}
      </div>

      {groups === null ? (
        <div style={{ padding: 20 }}>
          <Spinner />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: compact ? "column" : "row",
            minHeight: compact ? undefined : 320,
          }}
        >
          {/* rail — group list (wraps to a chip row at ≤1024) */}
          <div
            style={{
              flex: compact ? "none" : "0 0 240px",
              borderRight: compact ? "none" : "1px solid var(--line)",
              borderBottom: compact ? "1px solid var(--line)" : "none",
              background: "var(--card-2)",
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: compact ? "row" : "column",
                flexWrap: compact ? "wrap" : "nowrap",
                gap: compact ? 7 : 2,
              }}
            >
              {groups.length === 0 && (
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-3)",
                    padding: 6,
                  }}
                >
                  No groups yet — create one below.
                </div>
              )}
              {groups.map((g, i) => {
                const on = g.id === selId;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelId(g.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      minHeight: 44,
                      padding: "8px 10px",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      textAlign: "left",
                      border: `1px solid ${on ? "var(--line)" : "transparent"}`,
                      background: on ? "var(--card)" : "transparent",
                      color: "var(--ink)",
                      minWidth: compact ? 160 : 0,
                      flex: compact ? "1 1 180px" : undefined,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flex: "none",
                        background: DOTS[i % DOTS.length],
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 12.5,
                          fontWeight: "var(--weight-semibold)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {g.name}
                      </span>
                      <span
                        style={{ fontSize: 10.5, color: "var(--ink-faint)" }}
                      >
                        {g.members.length}{" "}
                        {g.members.length === 1 ? "member" : "members"} · all
                        workspaces
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {/* new group */}
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--line)",
              }}
            >
              <TextInput
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New group…"
                onKeyDown={(e) => e.key === "Enter" && void create()}
                style={{ flex: 1 }}
              />
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!newName.trim()}
                onClick={() => void create()}
              >
                Add
              </Button>
            </div>
          </div>

          {/* matrix pane — the selected group */}
          <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
            {selected ? (
              <GroupDetail
                key={selected.id}
                companyId={companyId}
                group={selected}
                dot={DOTS[(selIndex < 0 ? 0 : selIndex) % DOTS.length]}
                companyMembers={members}
                reload={reload}
                setErr={setErr}
                onDeleted={() => setSelId(null)}
              />
            ) : (
              <div
                style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}
              >
                Select or create a group to edit its permissions.
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

const CELL = 26;

function GroupDetail({
  companyId,
  group,
  dot,
  companyMembers,
  reload,
  setErr,
  onDeleted,
}: {
  companyId: string;
  group: CompanyGroup;
  dot: string;
  companyMembers: CompanyMember[];
  reload: () => Promise<void>;
  setErr: (e: string | null) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pickUid, setPickUid] = useState("");
  const [verbs, setVerbs] = useState<VerbSet>(() => verbsOf(group.grant));
  const [verbsDirty, setVerbsDirty] = useState(false);

  useEffect(() => {
    // Server state changed underneath (reload) — drop unsaved cell edits.
    setVerbs(verbsOf(group.grant));
    setVerbsDirty(false);
  }, [group.grant]);

  const inGroup = new Set(group.members.map((m) => m.userId));
  const addable = companyMembers.filter((m) => !inGroup.has(m.userId));

  async function run(fn: () => Promise<unknown>, failMsg: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch {
      setErr(failMsg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ animation: "naaryFadeUp .2s ease" }}>
      {/* pane header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            flex: "none",
            borderRadius: 9,
            border: `1px solid ${dot}`,
            color: dot,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
          }}
          aria-hidden
        >
          ◎
        </span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 15, fontWeight: "var(--weight-bold)" }}>
            {group.name}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            {group.members.length}{" "}
            {group.members.length === 1 ? "member" : "members"} · grants add up
            (union) across a member's groups
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          onClick={() =>
            void run(async () => {
              await api.deleteCompanyGroup(companyId, group.id);
              onDeleted();
            }, "Couldn't delete the group.")
          }
        >
          Delete
        </Button>
      </div>

      {/* applies-to (v1: always every attached workspace) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 13,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
          Applies to:
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-2)",
            background: "var(--card-2)",
            border: "1px solid var(--line)",
            borderRadius: 20,
            padding: "4px 10px",
          }}
        >
          All attached workspaces
        </span>
      </div>

      {/* grant matrix — v1 is a single all-workflows grant */}
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            border: "1px solid var(--line)",
            background: "var(--card)",
            borderRadius: "var(--radius-lg)",
            overflowX: "auto",
          }}
        >
          {/* header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "160px repeat(6,1fr)",
              minWidth: 560,
              padding: "10px 14px",
              borderBottom: "1px solid var(--line)",
              background: "var(--card-2)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              Scope target
            </span>
            {VERBS.map((v) => (
              <span
                key={v.key}
                style={{
                  fontSize: 10,
                  letterSpacing: ".03em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                  textAlign: "center",
                }}
              >
                {v.label}
              </span>
            ))}
          </div>
          {/* single grant row: All workflows */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "160px repeat(6,1fr)",
              minWidth: 560,
              padding: "12px 14px",
              alignItems: "center",
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  flex: "none",
                  borderRadius: 6,
                  border: "1px solid var(--brand)",
                  color: "var(--brand)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                }}
                aria-hidden
              >
                ≡
              </span>
              <span
                style={{ fontSize: 12, fontWeight: "var(--weight-semibold)" }}
              >
                All workflows
              </span>
            </span>
            {VERBS.map((v) => {
              const on = verbs[v.key];
              return (
                <span
                  key={v.key}
                  style={{ display: "flex", justifyContent: "center" }}
                >
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={v.label}
                    onClick={() => {
                      setVerbs({ ...verbs, [v.key]: !on });
                      setVerbsDirty(true);
                    }}
                    style={{
                      width: CELL,
                      height: CELL,
                      borderRadius: 7,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      border: `1px solid ${on ? "var(--state-done)" : "var(--line)"}`,
                      background: on ? "var(--state-done)" : "transparent",
                      color: on ? "#fff" : "var(--ink-faint)",
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    {on ? "✓" : ""}
                  </button>
                </span>
              );
            })}
          </div>
          {/* save */}
          <div
            style={{
              padding: "10px 14px",
              borderTop: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--ink-faint)", flex: 1 }}>
              A grant needs at least one verb. Changes apply after you save.
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !verbsDirty}
              onClick={() =>
                void run(
                  () => api.setCompanyGroupGrant(companyId, group.id, verbs),
                  "Couldn't save the permissions.",
                )
              }
            >
              Save permissions
            </Button>
          </div>
        </div>
      </div>

      {/* rename */}
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}
      >
        <TextInput
          value={renaming ?? group.name}
          onChange={(e) => setRenaming(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={
            busy ||
            renaming === null ||
            !renaming.trim() ||
            renaming.trim() === group.name
          }
          onClick={() =>
            void run(async () => {
              await api.renameCompanyGroup(
                companyId,
                group.id,
                (renaming ?? "").trim(),
              );
              setRenaming(null);
            }, "Couldn't rename the group.")
          }
        >
          Rename
        </Button>
      </div>

      {/* members */}
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          margin: "16px 0 6px",
        }}
      >
        Members{" "}
        <span style={{ color: "var(--ink-faint)" }}>
          (company members only)
        </span>
      </div>
      {group.members.length === 0 && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--ink-faint)",
            marginBottom: 6,
          }}
        >
          No members yet.
        </div>
      )}
      {group.members.map((m) => {
        const info = companyMembers.find((c) => c.userId === m.userId);
        return (
          <div
            key={m.userId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 0",
            }}
          >
            <span
              style={{
                flex: 1,
                fontSize: "var(--text-sm)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {info?.email ?? m.userId}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  () =>
                    api.removeCompanyGroupMember(companyId, group.id, m.userId),
                  "Couldn't remove the member.",
                )
              }
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          margin: "6px 0 2px",
        }}
      >
        <select
          value={pickUid}
          onChange={(e) => setPickUid(e.target.value)}
          style={{
            flex: 1,
            minHeight: 40,
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
          }}
        >
          <option value="">Add a company member…</option>
          {addable.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.email ?? m.userId}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !pickUid}
          onClick={() =>
            void run(async () => {
              await api.addCompanyGroupMember(companyId, group.id, pickUid);
              setPickUid("");
            }, "Couldn't add the member — they must be a company member.")
          }
        >
          Add
        </Button>
      </div>
    </div>
  );
}
