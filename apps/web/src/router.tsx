import * as Sentry from "@sentry/react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { RequireBuilder } from "./app/RequireBuilder";
import { RequireAuth } from "./auth/RequireAuth";
import { LoadingBlock } from "./components";

// Wrap the data-router factory so Sentry names navigation transactions by route
// pattern (not raw URL). No-op unless Sentry initialized (see instrument.ts).
const createRouter = Sentry.wrapCreateBrowserRouterV7(createBrowserRouter);

/**
 * Shown during the initial hydration window — the brief moment before the first
 * matched route's lazy() chunk resolves. A data router (createBrowserRouter) only
 * honors HydrateFallback on the ROOT route, so all routes hang off one pathless
 * root below; without it React Router warns "No HydrateFallback element provided".
 */
function RootHydrateFallback() {
  return <LoadingBlock style={{ minHeight: "100vh" }} label="Loading…" />;
}

const lazy = (
  importer: () => Promise<Record<string, React.ComponentType>>,
  name: string,
) => ({
  lazy: async () => {
    const mod = await importer();
    return { Component: mod[name] };
  },
});

export const router = createRouter([
  {
    // Pathless root layout — its sole purpose is to host HydrateFallback (only
    // honored on the root route) so the initial lazy-chunk load has a fallback
    // to render instead of warning. Renders its matched child via <Outlet/>.
    element: <Outlet />,
    HydrateFallback: RootHydrateFallback,
    children: [
      { path: "/", element: <Navigate to="/app" replace /> },
      {
        path: "/design",
        ...lazy(() => import("./screens/DesignSystemPage"), "DesignSystemPage"),
      },
      {
        path: "/auth",
        ...lazy(() => import("./screens/AuthPage"), "AuthPage"),
      },
      // Public hosted form (formTrigger) — anonymous, OUTSIDE RequireAuth (like /auth, /design).
      {
        path: "/f/:formId",
        ...lazy(() => import("./screens/FormPage"), "FormPage"),
      },
      // Public hosted chat (chatTrigger) — anonymous, OUTSIDE RequireAuth.
      {
        path: "/c/:chatId",
        ...lazy(() => import("./screens/ChatPage"), "ChatPage"),
      },
      // Public approve/reject decision page (signed link) — anonymous, OUTSIDE RequireAuth.
      {
        path: "/approve/:workflowId",
        ...lazy(() => import("./screens/ApprovePage"), "ApprovePage"),
      },
      // Everything under here requires a Keycloak session or a pasted nry_ token.
      {
        element: <RequireAuth />,
        children: [
          {
            // Full canvas — Builder-only. Sibling of /app, so AppShell's mode gating
            // doesn't cover it; RequireBuilder redirects Simple users to their automations.
            path: "/app/canvas",
            element: <RequireBuilder />,
            children: [
              {
                index: true,
                ...lazy(() => import("./screens/CanvasPage"), "CanvasPage"),
              },
            ],
          },
          {
            path: "/app",
            element: <AppShell />,
            children: [
              {
                index: true,
                ...lazy(() => import("./screens/app/Overview"), "Overview"),
              },
              // Simple mode (design PRODUCT-VARIANTS.md): automations = graphs, presented friendly.
              {
                path: "automations",
                ...lazy(
                  () => import("./screens/simple/Automations"),
                  "Automations",
                ),
              },
              {
                path: "automations/new",
                ...lazy(
                  () => import("./screens/simple/NewAutomation"),
                  "NewAutomation",
                ),
              },
              {
                path: "automations/:key",
                ...lazy(
                  () => import("./screens/simple/AutomationDetail"),
                  "AutomationDetail",
                ),
              },
              {
                path: "automations/:key/edit",
                ...lazy(
                  () => import("./screens/simple/AutomationEditPage"),
                  "AutomationEditPage",
                ),
              },
              {
                path: "connect-ai",
                ...lazy(
                  () => import("./screens/simple/ConnectAi"),
                  "ConnectAi",
                ),
              },
              {
                path: "build-ai",
                ...lazy(
                  () => import("./screens/app/BuildWithAi"),
                  "BuildWithAi",
                ),
              },
              {
                path: "workflows",
                ...lazy(() => import("./screens/app/Workflows"), "Workflows"),
              },
              {
                path: "workflows/:key",
                ...lazy(
                  () => import("./screens/app/WorkflowDetail"),
                  "WorkflowDetail",
                ),
              },
              {
                path: "runs",
                ...lazy(() => import("./screens/app/Runs"), "Runs"),
              },
              {
                path: "activity",
                ...lazy(() => import("./screens/app/Activity"), "Activity"),
              },
              {
                path: "approvals",
                ...lazy(() => import("./screens/app/Approvals"), "Approvals"),
              },
              {
                path: "schedules",
                ...lazy(() => import("./screens/app/Schedules"), "Schedules"),
              },
              {
                path: "runs/:id",
                ...lazy(() => import("./screens/app/RunDetail"), "RunDetail"),
              },
              {
                path: "templates",
                ...lazy(() => import("./screens/app/Templates"), "Templates"),
              },
              {
                path: "catalog",
                ...lazy(
                  () => import("./screens/app/NodeCatalog"),
                  "NodeCatalog",
                ),
              },
              {
                path: "integrations",
                ...lazy(
                  () => import("./screens/app/Integrations"),
                  "Integrations",
                ),
              },
              {
                path: "observability",
                ...lazy(
                  () => import("./screens/app/Observability"),
                  "Observability",
                ),
              },
              {
                path: "billing",
                ...lazy(() => import("./screens/app/Billing"), "Billing"),
              },
              {
                path: "team",
                ...lazy(() => import("./screens/app/Team"), "Team"),
              },
              {
                path: "groups",
                ...lazy(() => import("./screens/app/Groups"), "Groups"),
              },
              {
                path: "company",
                ...lazy(() => import("./screens/app/Company"), "Company"),
              },
              {
                path: "workers",
                ...lazy(() => import("./screens/app/Workers"), "Workers"),
              },
              {
                path: "settings",
                ...lazy(() => import("./screens/app/Settings"), "Settings"),
              },
            ],
          },
        ],
      },
    ],
  },
]);
