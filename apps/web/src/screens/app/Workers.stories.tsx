import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type { WorkerRow } from "../../lib/api";
import { Workers } from "./Workers";

// lastSeen values are authored relative to load time (Date.now() at module eval), so the screen's
// own live clock renders them as small "Xs ago" deltas. The last replica is intentionally stale
// (>45s ago) to exercise the offline/dimmed state.
const FLEET: WorkerRow[] = [
  {
    identity: "worker-7f3a/12/v0.0.12",
    host: "worker-7f3a",
    version: "v0.0.12",
    taskQueue: "orchestrator",
    activeActivities: 3,
    maxActivities: 100,
    online: true,
    lastSeen: new Date(Date.now() - 4_000).toISOString(),
  },
  {
    identity: "worker-b21c/9/v0.0.12",
    host: "worker-b21c",
    version: "v0.0.12",
    taskQueue: "orchestrator",
    activeActivities: 82,
    maxActivities: 100,
    online: true,
    lastSeen: new Date(Date.now() - 9_000).toISOString(),
  },
  {
    identity: "worker-c88e/4/v0.0.11",
    host: "worker-c88e",
    version: "v0.0.11",
    taskQueue: "orchestrator",
    activeActivities: 100,
    maxActivities: 100,
    online: true,
    lastSeen: new Date(Date.now() - 2_000).toISOString(),
  },
  {
    identity: "worker-19aa/7/v0.0.11",
    host: "worker-19aa",
    version: "v0.0.11",
    taskQueue: "orchestrator",
    activeActivities: 0,
    maxActivities: 50,
    online: false,
    lastSeen: new Date(Date.now() - 92_000).toISOString(),
  },
];

const meta: Meta<typeof Workers> = {
  title: "Screens/Workers",
  component: Workers,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ModeProvider>
        <Story />
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Workers>;

export const Populated: Story = {
  parameters: {
    msw: {
      handlers: [http.get("/api/workers", () => HttpResponse.json(FLEET))],
    },
  },
};

export const Empty: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/workers", () => HttpResponse.json([]))] },
  },
};

export const OperatorOnly: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/workers", () =>
          HttpResponse.json(
            {
              message:
                "Only workspace owners or admins can view the worker fleet.",
            },
            { status: 403 },
          ),
        ),
      ],
    },
  },
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/workers", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
      ],
    },
  },
};
