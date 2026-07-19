import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { workflowHandlers } from "./workflows/story-fixtures";
import { Workflows } from "./Workflows";

const meta: Meta<typeof Workflows> = {
  title: "Screens/Workflows",
  component: Workflows,
  parameters: {
    layout: "fullscreen",
    msw: { handlers: workflowHandlers },
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
type Story = StoryObj<typeof Workflows>;

/**
 * The redesigned list: trigger icon tiles + labels from each graph's entry
 * node, "Live in" glow dots from per-env presence (refund-triage = Live in
 * prod, GitHub reviewer = Paused in prod, lead-router = sandbox Draft),
 * last-run dots + 30d counts from the runs list, activation switches, tags,
 * and the All/Production/Active/Draft segmented filter.
 */
export const Populated: Story = {};

/** No workflows yet — the empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs", () => HttpResponse.json([])),
        http.get("*/api/executions", () => HttpResponse.json([])),
        http.get("*/api/me", () =>
          HttpResponse.json({ userId: "u1", email: "a@b.co", tenantId: "t1" }),
        ),
        http.get("*/api/me/permissions", () =>
          HttpResponse.json({ restricted: false }),
        ),
        http.get("*/api/tags", () => HttpResponse.json([])),
        http.get("*/api/tenants/:t/environments", () =>
          HttpResponse.json([
            { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
          ]),
        ),
      ],
    },
  },
};
