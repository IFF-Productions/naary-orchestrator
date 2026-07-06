/**
 * "No workspace yet" state (design §8): a fresh signup with no membership lands here
 * instead of a 401 loop. Creates the caller's first workspace (server-random id, owner
 * role) and the provider switches into it. Email must be verified first (server-enforced,
 * attack #6) — we surface that up front for a Firebase user whose email isn't verified.
 */
import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { Button, Card, EmptyState } from "../components";
import { useWorkspace } from "./WorkspaceProvider";

export function CreateWorkspace() {
  const { create } = useWorkspace();
  const { authenticated, emailVerified } = useAuth();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  // A Firebase user whose email isn't verified can't provision — tell them before the try.
  const blockedUnverified = authenticated && !emailVerified;

  async function onCreate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await create(name);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create the workspace.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <Card style={{ maxWidth: 460, width: "100%" }}>
        <EmptyState
          icon="workflow"
          title="Create your workspace"
          body={
            blockedUnverified
              ? "Verify your email address, then reload this page to create your first workspace."
              : "You don't belong to any workspace yet. Create one to start building and running workflows — you'll be its owner."
          }
          action={
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                alignItems: "center",
              }}
            >
              {!blockedUnverified && (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Workspace name (e.g. Acme Inc)"
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy) void onCreate();
                  }}
                  style={{
                    width: 260,
                    padding: "9px 11px",
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: "var(--card)",
                    color: "var(--ink)",
                    fontSize: 13,
                    fontFamily: "inherit",
                  }}
                />
              )}
              <Button
                variant="primary"
                icon="plus"
                disabled={busy || blockedUnverified}
                onClick={onCreate}
              >
                {busy ? "Creating…" : "Create workspace"}
              </Button>
              {error && (
                <div style={{ fontSize: 12, color: "var(--danger, #e5484d)" }}>
                  {error}
                </div>
              )}
            </div>
          }
        />
      </Card>
    </div>
  );
}
