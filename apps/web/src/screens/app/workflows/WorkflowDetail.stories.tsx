import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModeProvider } from "../../../mode";
import { WorkflowDetail } from "../WorkflowDetail";
import { EnvironmentsCard } from "./EnvironmentsCard";
import { VersionHistoryCard } from "./HistoryCards";
import type { EnvOverview } from "./model";
import {
  ENVIRONMENTS,
  GRAPHS_BY_ENV,
  PROMOTIONS,
  VERSIONS_BY_ENV,
  workflowHandlers,
} from "./story-fixtures";

const meta: Meta = {
  title: "Screens/Workflow detail",
  parameters: {
    layout: "fullscreen",
    msw: { handlers: workflowHandlers },
    // Route params for useParams — the shared preview router reads these.
    router: {
      path: "/app/workflows/:key",
      initialEntries: ["/app/workflows/refund-triage"],
    },
  },
  decorators: [
    (Story) => (
      <ModeProvider>
        <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
          <Story />
        </div>
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj;

/**
 * The full detail screen against msw: env tiles with real drift chips
 * (sandbox = active/source, UAT 1 version behind, prod 3 behind — by content
 * hash), promote + cross-env diff actions, version history with live-env
 * badges + promotion actors, recent runs, and the read-only graph preview.
 */
export const Detail: Story = { render: () => <WorkflowDetail /> };

/** The env overview the cards render below, assembled like useEnvOverview does. */
const OVERVIEW: EnvOverview = {
  activeEnv: ENVIRONMENTS[0],
  promotions: PROMOTIONS,
  envs: ENVIRONMENTS.map((env) => {
    const summary =
      GRAPHS_BY_ENV[env.id]?.find((g) => g.workflowKey === "refund-triage") ??
      null;
    const promo = summary
      ? PROMOTIONS.find(
          (p) => p.toEnvId === env.id && p.toVersion === summary.version,
        )
      : undefined;
    return {
      env,
      summary,
      versions: VERSIONS_BY_ENV[env.id] ?? [],
      promotedBy: promo
        ? { actor: promo.actor, at: promo.createdAt }
        : undefined,
    };
  }),
};

/** Environments card in isolation: active-env tile, drift chips, promote CTA. */
export const EnvironmentsCardStory: Story = {
  name: "Environments card",
  render: () => (
    <div style={{ maxWidth: 900, margin: "40px auto" }}>
      <EnvironmentsCard
        overview={OVERVIEW}
        target={ENVIRONMENTS[2]}
        onTargetChange={() => {}}
        mayPromote
        onViewDiff={() => {}}
        onPromote={() => {}}
      />
    </div>
  ),
};

/** Version history card: hashes, promotion actor, live-env badges. */
export const VersionHistoryStory: Story = {
  name: "Version history card",
  render: () => (
    <div style={{ maxWidth: 560, margin: "40px auto" }}>
      <VersionHistoryCard
        versions={VERSIONS_BY_ENV["e-sb"]}
        overview={OVERVIEW}
        onCompare={() => {}}
      />
    </div>
  ),
};
