import { Navigate, Outlet } from "react-router-dom";
import { useMode } from "../mode";

/**
 * Route guard for Builder-only screens that live OUTSIDE AppShell (e.g. /app/canvas,
 * a sibling route). AppShell gates Builder routes for Simple users, but sibling routes
 * bypass it — so a Simple user could reach the full canvas by direct URL. This mirrors
 * AppShell's redirect: Simple mode → send them to their automations.
 */
export function RequireBuilder() {
  const { mode } = useMode();
  if (mode === "simple") return <Navigate to="/app/automations" replace />;
  return <Outlet />;
}
