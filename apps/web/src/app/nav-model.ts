/**
 * Five-mode navigation model (redesign shell, design "Naary Shell.dc.html").
 * All app screens group under five color-coded verbs — Build / Operate / Observe /
 * Connect / Admin — rendered by the NavRail; the BreadcrumbBar derives
 * `Hub › Mode › Screen` from the same model. Environments, workspaces and the
 * Builder/Simple variant are CONTEXT (the top bar), never nav destinations.
 */
import type { IconName } from "../components";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Live count key resolved by the shell (e.g. approvals waiting). */
  badgeKey?: "approvals";
  /** Opens outside the shell chrome (full-bleed canvas). */
  external?: boolean;
}

export interface NavMode {
  id: string;
  label: string;
  icon: IconName;
  /** Mode accent CSS var — colors the section header, badges and hub tiles. */
  color: string;
  tagline: string;
  items: NavItem[];
}

export const BUILDER_MODES: NavMode[] = [
  {
    id: "build",
    label: "Build",
    icon: "mode-build",
    color: "var(--mode-build)",
    tagline: "author & compose",
    items: [
      { to: "/app/workflows", label: "Workflows", icon: "workflow" },
      {
        to: "/app/canvas",
        label: "Canvas editor",
        icon: "edit",
        external: true,
      },
      { to: "/app/catalog", label: "Node catalog", icon: "router" },
      { to: "/app/templates", label: "Templates", icon: "template" },
    ],
  },
  {
    id: "operate",
    label: "Operate",
    icon: "mode-operate",
    color: "var(--mode-operate)",
    tagline: "run day to day",
    items: [
      { to: "/app", label: "Overview", icon: "grid", badgeKey: "approvals" },
      { to: "/app/runs", label: "Runs", icon: "activity" },
      {
        to: "/app/approvals",
        label: "Approvals",
        icon: "approval",
        badgeKey: "approvals",
      },
      { to: "/app/schedules", label: "Schedules", icon: "clock" },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    icon: "mode-observe",
    color: "var(--mode-observe)",
    tagline: "what happened",
    items: [
      { to: "/app/observability", label: "Insights & logs", icon: "chart" },
      { to: "/app/billing", label: "Usage & budgets", icon: "card" },
    ],
  },
  {
    id: "connect",
    label: "Connect",
    icon: "mode-connect",
    color: "var(--mode-connect)",
    tagline: "wire to the world",
    items: [{ to: "/app/integrations", label: "Integrations", icon: "plug" }],
  },
  {
    id: "admin",
    label: "Admin",
    icon: "mode-admin",
    color: "var(--mode-admin)",
    tagline: "account & governance",
    items: [
      { to: "/app/team", label: "Team", icon: "users" },
      { to: "/app/groups", label: "Groups", icon: "key" },
      { to: "/app/company", label: "Company", icon: "mode-admin" },
      { to: "/app/settings", label: "Settings", icon: "settings" },
    ],
  },
];

// Simple-mode nav (design PRODUCT-VARIANTS.md §6) — a subset lens over the same
// engine: no canvas / integrations / observability, same runs + approvals truth.
export const SIMPLE_MODES: NavMode[] = [
  {
    id: "automate",
    label: "Automate",
    icon: "mode-build",
    color: "var(--mode-build)",
    tagline: "your automations",
    items: [
      { to: "/app/automations", label: "Automations", icon: "workflow" },
      { to: "/app/runs", label: "Runs", icon: "activity" },
      {
        to: "/app/approvals",
        label: "Approvals",
        icon: "approval",
        badgeKey: "approvals",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    icon: "mode-admin",
    color: "var(--mode-admin)",
    tagline: "account",
    items: [
      { to: "/app/connect-ai", label: "Connect AI", icon: "plug" },
      { to: "/app/settings", label: "Settings", icon: "settings" },
    ],
  },
];

// Paths a Simple-mode user may reach; anything else under /app redirects to /app/automations.
export const SIMPLE_ALLOWED = [
  "/app/automations",
  "/app/runs",
  "/app/approvals",
  "/app/settings",
  "/app/connect-ai",
];

/** Longest-prefix match of the current pathname into the nav model (for the
 *  breadcrumb + rail active state). `/app` (Overview) matches exactly only. */
export function findCrumb(
  pathname: string,
  modes: NavMode[],
): { mode: NavMode; item: NavItem } | undefined {
  let best: { mode: NavMode; item: NavItem } | undefined;
  for (const mode of modes) {
    for (const item of mode.items) {
      const match =
        item.to === "/app"
          ? pathname === "/app"
          : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (match && (!best || item.to.length > best.item.to.length)) {
        best = { mode, item };
      }
    }
  }
  return best;
}
