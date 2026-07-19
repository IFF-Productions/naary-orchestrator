import { Navigate } from "react-router-dom";

/**
 * Activity folded into Observe › Audit (redesign IA: Runs + Observability +
 * Activity collapse into one Observe surface). The /app/activity route keeps
 * working as a redirect so old links and bookmarks land on the audit tab.
 */
export function Activity() {
  return <Navigate to="/app/observability?tab=audit" replace />;
}
