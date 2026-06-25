import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "./app/AppShell";

const lazy = (
  importer: () => Promise<Record<string, React.ComponentType>>,
  name: string,
) => ({
  lazy: async () => {
    const mod = await importer();
    return { Component: mod[name] };
  },
});

export const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/app" replace /> },
  {
    path: "/design",
    ...lazy(() => import("./screens/DesignSystemPage"), "DesignSystemPage"),
  },
  { path: "/auth", ...lazy(() => import("./screens/AuthPage"), "AuthPage") },
  {
    path: "/app/canvas",
    ...lazy(() => import("./screens/CanvasPage"), "CanvasPage"),
  },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      {
        index: true,
        ...lazy(() => import("./screens/app/Overview"), "Overview"),
      },
      {
        path: "workflows",
        ...lazy(() => import("./screens/app/Workflows"), "Workflows"),
      },
      { path: "runs", ...lazy(() => import("./screens/app/Runs"), "Runs") },
      {
        path: "runs/:id",
        ...lazy(() => import("./screens/app/RunDetail"), "RunDetail"),
      },
      {
        path: "templates",
        ...lazy(() => import("./screens/app/Templates"), "Templates"),
      },
      {
        path: "integrations",
        ...lazy(() => import("./screens/app/Integrations"), "Integrations"),
      },
      {
        path: "observability",
        ...lazy(() => import("./screens/app/Observability"), "Observability"),
      },
      {
        path: "billing",
        ...lazy(() => import("./screens/app/Billing"), "Billing"),
      },
      { path: "team", ...lazy(() => import("./screens/app/Team"), "Team") },
      {
        path: "settings",
        ...lazy(() => import("./screens/app/Settings"), "Settings"),
      },
    ],
  },
]);
