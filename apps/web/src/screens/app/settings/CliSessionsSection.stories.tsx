import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { CliSessionsSection } from "./CliSessionsSection";

// The "CLI sessions" settings card (#1078 §5) — one row per DEVICE signed in through `naary auth`.
//
// It exists mainly for the CONFIRM DIALOG. That copy is a security promise ("this device is signed
// out immediately"), it changed when `ApiToken.familyId` made the promise true, and it is only
// reachable by clicking Sign out on a populated list — which needs a backend. MSW supplies one, so
// the claim can be read on the real component instead of in a diff.
const meta: Meta<typeof CliSessionsSection> = {
  title: "Settings/CliSessionsSection",
};
export default meta;
type Story = StoryObj<typeof CliSessionsSection>;

const hoursAgo = (h: number) =>
  new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) =>
  new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number) =>
  new Date(Date.now() + d * 86_400_000).toISOString();

const handlers = [
  http.get("*/api/cli-sessions", () =>
    HttpResponse.json([
      {
        familyId: "3f2a9c10-0b6e-4a1d-9d2f-6c1b8a0e5d33",
        label: "naary CLI — hassans-macbook",
        createdAt: daysAgo(9),
        lastUsedAt: hoursAgo(3),
        expiresAt: daysAhead(81),
      },
      {
        familyId: "8c41d7b2-55e3-4f0a-b7c9-2e14a6d90f77",
        label: "naary CLI — build-runner-02",
        createdAt: daysAgo(21),
        lastUsedAt: daysAgo(2),
        expiresAt: daysAhead(69),
      },
    ]),
  ),
  http.delete("*/api/cli-sessions/*", () =>
    HttpResponse.json({ revoked: true }),
  ),
];

export const Populated: Story = {
  parameters: { msw: { handlers } },
  render: () => (
    <div style={{ maxWidth: 680, padding: 24 }}>
      <CliSessionsSection />
    </div>
  ),
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("*/api/cli-sessions", () => HttpResponse.json([]))],
    },
  },
  render: () => (
    <div style={{ maxWidth: 680, padding: 24 }}>
      <CliSessionsSection />
    </div>
  ),
};
