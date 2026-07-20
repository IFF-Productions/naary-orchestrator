import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { AuthProvider } from "../auth/AuthProvider";
import { ModeProvider } from "../mode";
import { ThemeProvider } from "../theme";
import { WorkspaceProvider } from "../workspace/WorkspaceProvider";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ContextBar } from "./ContextBar";
import { NavRail } from "./NavRail";
import { BUILDER_MODES, SIMPLE_MODES } from "./nav-model";

const WORKSPACES = [
  { tenantId: "t1", role: "owner", name: "Acme Corp" },
  { tenantId: "t2", role: "member", name: "Northwind" },
];

const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
];

const AWAITING = Array.from({ length: 6 }, (_, i) => ({
  workflowId: `wh-t1-${i}`,
  workflowKey: "refund-triage",
  nodeId: "approve",
  title: `Approval ${i + 1}`,
  instructions: null,
  createdAt: new Date("2026-07-16T09:05:00Z").toISOString(),
}));

const handlers = [
  http.get("*/api/me/workspaces", () => HttpResponse.json(WORKSPACES)),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
  http.get("*/api/executions/awaiting", () => HttpResponse.json(AWAITING)),
  http.get("*/api/executions", () => HttpResponse.json([])),
];

/** The full provider stack the chrome reads (theme · mode · auth · workspace). */
function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ModeProvider>
        <AuthProvider>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </AuthProvider>
      </ModeProvider>
    </ThemeProvider>
  );
}

const meta: Meta = {
  title: "App chrome/Shell",
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
    router: { initialEntries: ["/app/approvals"] },
  },
};
export default meta;
type Story = StoryObj;

/** The persistent 52px context bar: brand · workspace · env segments · variant · approvals pill. */
export const ContextBarStory: Story = {
  name: "Context bar",
  render: () => (
    <Providers>
      <div style={{ background: "var(--bg)", minHeight: 220 }}>
        <ContextBar
          approvalsCount={6}
          compact={false}
          drawerOpen={false}
          onToggleDrawer={() => {}}
        />
      </div>
    </Providers>
  ),
};

/** The five-mode rail — Build / Operate / Observe / Connect / Admin, approvals badged. */
export const Rail: Story = {
  render: () => (
    <Providers>
      <div
        style={{
          width: 236,
          height: 640,
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          borderRight: "1px solid var(--line)",
        }}
      >
        <NavRail
          modes={BUILDER_MODES}
          approvalsCount={6}
          rail={false}
          collapsed={false}
          showCollapseToggle
          onCollapseToggle={() => {}}
        />
      </div>
    </Providers>
  ),
};

/** Icon-only rail (tablet auto-collapse / desktop manual collapse). */
export const RailCollapsed: Story = {
  render: () => (
    <Providers>
      <div
        style={{
          width: 70,
          height: 640,
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          borderRight: "1px solid var(--line)",
        }}
      >
        <NavRail
          modes={BUILDER_MODES}
          approvalsCount={6}
          rail
          collapsed
          showCollapseToggle
          onCollapseToggle={() => {}}
        />
      </div>
    </Providers>
  ),
};

/** Simple-variant rail — the subset lens (no canvas / integrations / observability). */
export const RailSimple: Story = {
  render: () => (
    <Providers>
      <div
        style={{
          width: 236,
          height: 480,
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          borderRight: "1px solid var(--line)",
        }}
      >
        <NavRail
          modes={SIMPLE_MODES}
          approvalsCount={2}
          rail={false}
          collapsed={false}
          showCollapseToggle={false}
          onCollapseToggle={() => {}}
        />
      </div>
    </Providers>
  ),
};

/** Breadcrumb: Hub › Mode › Screen + the inline env echo (prod = hot ember). */
export const Breadcrumb: Story = {
  render: () => (
    <Providers>
      <div style={{ background: "var(--bg)", minHeight: 120 }}>
        <BreadcrumbBar
          modes={BUILDER_MODES}
          envName="prod"
          envAccent="var(--env-prod)"
        />
      </div>
    </Providers>
  ),
};

/** The whole chrome composed — bar over rail + breadcrumb'd content region. */
export const FullChrome: Story = {
  render: () => (
    <Providers>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <ContextBar
          approvalsCount={6}
          compact={false}
          drawerOpen={false}
          onToggleDrawer={() => {}}
        />
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <aside
            style={{
              width: 236,
              flex: "none",
              display: "flex",
              flexDirection: "column",
              background: "var(--panel)",
              borderRight: "1px solid var(--line)",
            }}
          >
            <NavRail
              modes={BUILDER_MODES}
              approvalsCount={6}
              rail={false}
              collapsed={false}
              showCollapseToggle
              onCollapseToggle={() => {}}
            />
          </aside>
          <main
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              background:
                "radial-gradient(120% 70% at 85% -5%, var(--grad-a), var(--bg) 55%)",
            }}
          >
            <BreadcrumbBar
              modes={BUILDER_MODES}
              envName="prod"
              envAccent="var(--env-prod)"
            />
            <div style={{ padding: "34px 40px" }}>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  color: "var(--brand)",
                  letterSpacing: ".06em",
                  marginBottom: 12,
                }}
              >
                UNIFIED SHELL · FIVE MODES
              </div>
              <div
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: "-.02em",
                  color: "var(--ink)",
                }}
              >
                One frame for every surface.
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "var(--ink-2)",
                  marginTop: 10,
                  maxWidth: 600,
                  lineHeight: 1.6,
                }}
              >
                The nav groups every screen into five verbs — Build, Operate,
                Observe, Connect, Admin — and the bar above pins workspace,
                environment, and variant across all of them.
              </div>
            </div>
          </main>
        </div>
      </div>
    </Providers>
  ),
};
