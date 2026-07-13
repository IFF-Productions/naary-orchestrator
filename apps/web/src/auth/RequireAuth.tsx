/**
 * Route guard for the app. Waits for Firebase init, then renders the protected routes only
 * when there's a session OR a pasted `nry_` token; otherwise sends the user to /auth. Once
 * past auth, the WorkspaceProvider resolves the caller's workspaces and gates on them: a
 * user with none lands on the create-workspace screen (design §8), not a 401 loop.
 * Used as a pathless layout route wrapping /app (and the canvas).
 */
import { Navigate, Outlet } from "react-router-dom";
import { Button } from "../components";
import { hasToken } from "../lib/auth";
import { NotAvailable } from "../screens/NotAvailable";
import { CreateWorkspace } from "../workspace/CreateWorkspace";
import {
  WorkspaceProvider,
  useWorkspace,
} from "../workspace/WorkspaceProvider";
import { useAuth } from "./AuthProvider";

export function RequireAuth() {
  const { ready, authenticated } = useAuth();

  // Don't flash the sign-in screen (or the app) before init resolves.
  if (!ready) return null;

  if (!authenticated && !hasToken()) {
    return <Navigate to="/auth" replace />;
  }
  return (
    <WorkspaceProvider>
      <WorkspaceGate />
    </WorkspaceProvider>
  );
}

/** Gates the app on workspace resolution: loading → nothing; error → retry; no workspace →
 *  create screen; otherwise the routed app. */
function WorkspaceGate() {
  const { loading, error, needsWorkspace, accessDenied, refresh } =
    useWorkspace();

  if (loading) return null;
  // Signed in, but the server's access allowlist rejected this user (early access).
  if (accessDenied) return <NotAvailable />;
  if (error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--ink-2)",
          fontSize: 13,
        }}
      >
        <div>Couldn't load your workspaces.</div>
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (needsWorkspace) return <CreateWorkspace />;
  return <Outlet />;
}
