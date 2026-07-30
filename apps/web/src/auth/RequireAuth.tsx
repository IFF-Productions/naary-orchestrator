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
import { MfaRequired } from "../screens/MfaRequired";
import { NotAvailable } from "../screens/NotAvailable";
import { CreateWorkspace } from "../workspace/CreateWorkspace";
import { FlagsProvider } from "../workspace/FlagsProvider";
import {
  WorkspaceProvider,
  useWorkspace,
} from "../workspace/WorkspaceProvider";
import { useAuthSession } from "./AuthProvider";

export function RequireAuth() {
  // useAuthSession, not useAuth: this is the component that DECLARES the app needs Firebase, so
  // it activates the async auth boundary (lib/firebase-lazy) on mount. The route also carries a
  // loader that warms it in parallel with the lazy chunk — this is the belt to that braces, and
  // what makes the guard work outside the router (Storybook, tests).
  const { ready, authenticated } = useAuthSession();

  // Don't flash the sign-in screen (or the app) before init resolves. `ready` now also covers the
  // SDK chunk's own fetch, so this window is a round trip longer than it was — deliberately, and
  // still a blank gate rather than a flash of the wrong UI.
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
  const { loading, error, needsWorkspace, accessDenied, mfaRequired, refresh } =
    useWorkspace();

  if (loading) return null;
  // Signed in, but the server's access allowlist rejected this user (early access).
  if (accessDenied) return <NotAvailable />;
  // Signed in with a single factor while the instance requires MFA (#457) — a distinct,
  // actionable state (enrol + sign in again), checked before the generic error branch.
  if (mfaRequired) return <MfaRequired />;
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
  // A workspace is resolved here → mount the flags fetch under it (re-fetches on switch via
  // WorkspaceProvider's key remount). Fail-safe, so it never gates the app render (#491).
  return (
    <FlagsProvider>
      <Outlet />
    </FlagsProvider>
  );
}
