import { useEffect, useState } from "react";
import { Button, Card, Spinner, TextInput } from "../../../components";
import { api, type CompanyMember } from "../../../lib/api";
import { ErrorLine } from "./misc";

/**
 * Company members (Slice 4): list with roles; owner-only add form (email + owner/admin —
 * NO invitations: the email must already have signed in, mirroring Team.tsx's invite style);
 * remove is owner-only except self-leave. Last-owner demote/removal is refused server-side (409).
 */
export function MembersCard({
  companyId,
  isOwner,
}: {
  companyId: string;
  isOwner: boolean;
}) {
  const [members, setMembers] = useState<CompanyMember[] | null>(null);
  const [myUid, setMyUid] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "admin">("admin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMembers(null);
    setErr(null);
    api
      .listCompanyMembers(companyId)
      .then((m) => live && setMembers(m))
      .catch(() => live && setErr("Couldn't load the company members."));
    api
      .getMe()
      .then((me) => live && setMyUid(me.subject ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [companyId]);

  async function add() {
    if (!email.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addCompanyMember(companyId, email.trim(), role);
      setEmail("");
      setMembers(await api.listCompanyMembers(companyId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // http() throws generic "<METHOD> <path> → <status>" errors — map the meaningful ones.
      if (msg.includes("→ 404")) {
        setErr("No account with that email — they must sign in first.");
      } else if (msg.includes("→ 409")) {
        setErr("A company must keep at least one owner.");
      } else if (msg.includes("→ 403")) {
        setErr("Only the company owner can manage members.");
      } else {
        setErr("Couldn't add the member.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setErr(null);
    try {
      await api.removeCompanyMember(companyId, userId);
      setMembers((ms) => (ms ?? []).filter((m) => m.userId !== userId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setErr(
        msg.includes("→ 409")
          ? "A company must keep at least one owner."
          : "Couldn't remove the member.",
      );
    }
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <div
        style={{
          fontWeight: "var(--weight-semibold)",
          marginBottom: 10,
        }}
      >
        Members
      </div>
      {err && <ErrorLine text={err} />}
      {isOwner && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <TextInput
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@company.com"
            type="email"
            style={{ flex: 1 }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "owner" | "admin")}
            style={{ padding: "8px 10px", borderRadius: "var(--radius-md)" }}
          >
            <option value="admin">admin</option>
            <option value="owner">owner</option>
          </select>
          <Button
            variant="primary"
            loading={busy}
            disabled={!email.trim()}
            onClick={() => void add()}
          >
            Add
          </Button>
        </div>
      )}
      {members === null ? (
        <Spinner />
      ) : members.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No members.
        </div>
      ) : (
        members.map((m) => (
          <div
            key={m.userId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "9px 2px",
              borderTop: "1px solid var(--line)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.email ?? m.userId}
                {m.userId === myUid ? " (you)" : ""}
              </span>
            </div>
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: m.role === "owner" ? "var(--brand)" : "var(--ink-2)",
              }}
            >
              {m.role}
            </span>
            {(isOwner || m.userId === myUid) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(m.userId)}
              >
                {m.userId === myUid ? "Leave" : "Remove"}
              </Button>
            )}
          </div>
        ))
      )}
    </Card>
  );
}
