import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ModeProvider } from "../../mode";
import { Approvals } from "./Approvals";

// Ages are computed relative to "now" so all three waiting-age urgency tones show:
// <4h neutral · 4–24h warn · >24h bad (the screen derives urgency from createdAt —
// the backend has no SLA config on approvals).
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const AWAITING = [
  {
    workflowId: "wh-t1-9a8b7c",
    workflowKey: "refund-triage",
    nodeId: "approve",
    title: "Refund over $500",
    instructions:
      "Customer ada@globex.com requested a $612 refund for order #48213 (late delivery). Approving issues the refund via Stripe and closes the ticket.",
    createdAt: ago(25), // neutral
  },
  {
    workflowId: "wh-t1-b7c210",
    workflowKey: "invoice-sync",
    nodeId: "gate",
    title: "Vendor payout $12,500",
    // Structured JSON instructions render as the key/value fields card.
    instructions: JSON.stringify({
      Vendor: "Acme Cloud",
      Amount: "$12,500",
      Terms: "Net 30",
      PO: "PO-2291",
    }),
    createdAt: ago(6 * 60), // warn
  },
  {
    workflowId: "wh-t1-c3d881",
    workflowKey: "access-request",
    nodeId: "security-gate",
    title: "Grant prod DB read access",
    instructions:
      "Temporary read-only access to the production analytics DB for 7 days. Approving provisions a scoped, expiring credential.",
    createdAt: ago(2 * 24 * 60 + 4 * 60), // bad — 2d 4h
  },
  {
    workflowId: "wh-t1-d9f012",
    workflowKey: "content-publish",
    nodeId: "review",
    title: 'Publish blog post "Q3 launch"',
    instructions: null, // no-instructions fallback in the detail panel
    createdAt: ago(30 * 60), // bad — 1d 6h
  },
  {
    workflowId: "wh-t1-e4a773",
    workflowKey: "deal-won-notifier",
    nodeId: "approve",
    title: "Send $48,000 deal-won notification",
    instructions:
      "A Series-B deal closed for Northwind. Approving sends the win notification to #deals and updates the CRM stage.",
    createdAt: ago(2 * 60), // neutral
  },
];

const handlers = [
  http.get("*/api/executions/awaiting", () => HttpResponse.json(AWAITING)),
  // Decide-in-place works in the story playground too.
  http.post("*/api/executions/:id/approve", () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post("*/api/executions/approve-batch", async ({ request }) => {
    const body = (await request.json()) as { ids: string[] };
    return HttpResponse.json(
      body.ids.map((id) => ({ workflowId: id, ok: true })),
    );
  }),
];

const meta: Meta<typeof Approvals> = {
  title: "Screens/Approvals",
  component: Approvals,
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
    router: { initialEntries: ["/app/approvals"] },
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
type Story = StoryObj<typeof Approvals>;

/** Populated inbox — mixed waiting ages (neutral / warn / bad chips), first row focused in the detail panel. */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getAllByText(/Refund over \$500/).length).toBeGreaterThan(
        0,
      ),
    );
  },
};

/** Two rows checked — the filter chips swap for the batch bar (N selected · Approve N · Reject N · Clear). */
export const BatchSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getAllByText(/Refund over \$500/).length).toBeGreaterThan(
        0,
      ),
    );
    // Checkbox 0 is select-all in the filter bar; 1..n are the queue rows.
    const boxes = canvas.getAllByRole("checkbox");
    await userEvent.click(boxes[1]);
    await userEvent.click(boxes[2]);
    await waitFor(() => expect(canvas.getByText("2 selected")).toBeTruthy());
    await expect(
      canvas.getByRole("button", { name: /Approve 2/ }),
    ).toBeTruthy();
  },
};

/** The detail panel showing structured JSON instructions as the key/value fields card. */
export const StructuredContext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole("button", {
      name: /Vendor payout \$12,500/,
    });
    await userEvent.click(row);
    await waitFor(() => expect(canvas.getByText("PO-2291")).toBeTruthy());
  },
};

/** Inbox zero — the empty state teaches where approvals come from. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/executions/awaiting", () => HttpResponse.json([])),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Inbox zero")).toBeTruthy());
  },
};
