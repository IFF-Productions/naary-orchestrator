// Company-wide permission groups (RBAC-GROUPS §9): owner-only card on the company console.
// A group's grant applies to ALL workflows in ALL attached workspaces, every environment —
// and only ADDS access back for members a workspace has already restricted via its own
// first-grant cliff; it never restricts anyone. uid-keyed only (no API tokens).
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Spinner, TextInput } from "../../components";
import {
  api,
  type CompanyGroup,
  type CompanyGroupGrant,
  type CompanyMember,
} from "../../lib/api";

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

function verbsOf(grant: CompanyGroupGrant | null): VerbSet {
  if (!grant) return { ...NO_VERBS };
  const set = { ...NO_VERBS };
  for (const v of VERBS) set[v.key] = grant[v.key];
  return set;
}

/** Owner-only Groups card for the company console (rendered by Company.tsx). */
export function CompanyGroupsCard({ companyId }: { companyId: string }) {
  const [groups, setGroups] = useState<CompanyGroup[] | null>(null);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setGroups(await api.listCompanyGroups(companyId));
  }, [companyId]);

  useEffect(() => {
    let live = true;
    setGroups(null);
    setOpenId(null);
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

  async function create() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const g = await api.createCompanyGroup(companyId, newName.trim());
      setNewName("");
      await reload();
      setOpenId(g.id);
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
    <Card style={{ marginTop: 16 }}>
      <div style={{ fontWeight: "var(--weight-semibold)", marginBottom: 4 }}>
        Permission groups
      </div>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
        Company-wide access for restricted members: a group's permissions apply
        to ALL workflows in ALL attached workspaces, every environment. They
        only add access back where a workspace already restricts its members —
        an unrestricted workspace is unaffected.
      </div>
      {err && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            margin: "8px 0",
          }}
        >
          {err}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <TextInput
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Platform admins"
          style={{ flex: 1 }}
        />
        <Button
          variant="primary"
          disabled={busy || !newName.trim()}
          onClick={() => void create()}
        >
          {busy ? "Creating…" : "New group"}
        </Button>
      </div>
      {groups === null ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No groups yet.
        </div>
      ) : (
        groups.map((g) => (
          <GroupRow
            key={g.id}
            companyId={companyId}
            group={g}
            companyMembers={members}
            open={openId === g.id}
            setOpen={(o) => setOpenId(o ? g.id : null)}
            reload={reload}
            setErr={setErr}
          />
        ))
      )}
    </Card>
  );
}

function GroupRow({
  companyId,
  group,
  companyMembers,
  open,
  setOpen,
  reload,
  setErr,
}: {
  companyId: string;
  group: CompanyGroup;
  companyMembers: CompanyMember[];
  open: boolean;
  setOpen: (o: boolean) => void;
  reload: () => Promise<void>;
  setErr: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pickUid, setPickUid] = useState("");
  const [verbs, setVerbs] = useState<VerbSet>(() => verbsOf(group.grant));
  const [verbsDirty, setVerbsDirty] = useState(false);

  useEffect(() => {
    // Server state changed underneath (reload) — drop unsaved checkbox edits.
    setVerbs(verbsOf(group.grant));
    setVerbsDirty(false);
  }, [group.grant]);

  const inGroup = new Set(group.members.map((m) => m.userId));
  const addable = companyMembers.filter((m) => !inGroup.has(m.userId));
  const activeVerbs = VERBS.filter((v) => group.grant?.[v.key]);

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
    <div style={{ borderTop: "1px solid var(--line)", padding: "10px 2px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ color: "var(--ink)" }}>{group.name}</span>
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              marginLeft: 8,
            }}
          >
            {group.members.length}{" "}
            {group.members.length === 1 ? "member" : "members"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {activeVerbs.length === 0 ? (
            <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
              no permissions
            </span>
          ) : (
            activeVerbs.map((v) => (
              <span
                key={v.key}
                style={{
                  fontSize: 10.5,
                  padding: "1px 7px",
                  borderRadius: 99,
                  border: "1px solid var(--line)",
                  color: "var(--ink-2)",
                }}
              >
                {v.label}
              </span>
            ))
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          onClick={() =>
            void run(
              () => api.deleteCompanyGroup(companyId, group.id),
              "Couldn't delete the group.",
            )
          }
        >
          Delete
        </Button>
      </div>

      {open && (
        <div style={{ marginTop: 10, paddingLeft: 2 }}>
          {/* rename */}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 10,
            }}
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
              marginBottom: 6,
            }}
          >
            Members (company members only)
          </div>
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
                        api.removeCompanyGroupMember(
                          companyId,
                          group.id,
                          m.userId,
                        ),
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
              margin: "6px 0 12px",
            }}
          >
            <select
              value={pickUid}
              onChange={(e) => setPickUid(e.target.value)}
              style={{
                flex: 1,
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

          {/* grant */}
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginBottom: 2,
            }}
          >
            Permissions
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ink-3)",
              marginBottom: 8,
            }}
          >
            Applies to ALL workflows in ALL attached workspaces, every
            environment.
          </div>
          <div
            style={{
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {VERBS.map((v) => (
              <label
                key={v.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink)",
                }}
              >
                <input
                  type="checkbox"
                  checked={verbs[v.key]}
                  onChange={(e) => {
                    setVerbs({ ...verbs, [v.key]: e.target.checked });
                    setVerbsDirty(true);
                  }}
                />
                {v.label}
              </label>
            ))}
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
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
