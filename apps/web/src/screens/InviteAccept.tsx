/**
 * Accept-invitation screen (`/invite/:token`, design §8). The invitee opens the shared
 * link; once signed in (with a verified email matching the invite), accepting joins them to
 * the workspace and switches into it. This route is intentionally OUTSIDE the workspace gate
 * — a brand-new invitee has no workspace yet, and accepting is how they get their first.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Card, EmptyState } from "../components";
import { hasToken } from "../lib/auth";
import { api, setActiveWorkspace } from "../lib/api";

export function InviteAccept() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { ready, authenticated } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const signedIn = authenticated || hasToken();

  async function accept(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      const { tenantId } = await api.acceptInvitation(token);
      // Switch into the joined workspace, then land in the app (which refetches under it).
      setActiveWorkspace(tenantId);
      navigate("/app");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not accept this invitation.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={shellStyle}>
      <Card style={{ maxWidth: 460, width: "100%" }}>
        {!ready ? null : !token ? (
          <EmptyState title="Invalid invite link" />
        ) : !signedIn ? (
          <EmptyState
            icon="users"
            title="You've been invited"
            body="Sign in with the invited email address, then reopen this link to join the workspace."
            action={
              <Button variant="primary" onClick={() => navigate("/auth")}>
                Sign in
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="users"
            title="Join this workspace"
            body="Accept the invitation to join. Your email must be verified and match the address it was sent to."
            action={
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <Button
                  variant="primary"
                  icon="check"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy ? "Joining…" : "Accept invitation"}
                </Button>
                {error && (
                  <div
                    style={{ fontSize: 12, color: "var(--danger, #e5484d)" }}
                  >
                    {error}
                  </div>
                )}
              </div>
            }
          />
        )}
      </Card>
    </div>
  );
}

const shellStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg)",
  padding: 24,
};
