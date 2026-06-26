/**
 * Route guard for the app. Waits for Keycloak init, then renders the protected
 * routes only when there's a session OR a pasted `nry_` token; otherwise sends the
 * user to /auth. Used as a pathless layout route wrapping /app (and the canvas).
 */
import { Navigate, Outlet } from "react-router-dom";
import { hasToken } from "../lib/auth";
import { useAuth } from "./AuthProvider";

export function RequireAuth() {
  const { ready, authenticated } = useAuth();

  // Don't flash the sign-in screen (or the app) before init resolves.
  if (!ready) return null;

  if (!authenticated && !hasToken()) {
    return <Navigate to="/auth" replace />;
  }
  return <Outlet />;
}
