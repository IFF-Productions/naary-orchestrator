import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ApprovePage } from "../ApprovePage";
import { ChatPage } from "../ChatPage";
import { FormPage } from "../FormPage";

/**
 * The three BRANDED PUBLIC pages (outside the app shell + auth) against msw-mocked public
 * endpoints, using the REAL response shapes: forms return `{ status: "started" }` on submit,
 * chat returns `{ status, reply? }` (no citations), approvals return `{ awaiting, title,
 * instructions }` and decide returns the recorded `{ status }`. No workspace providers needed —
 * these pages read only route params + the anonymous api module.
 */

const FORM_DEF = {
  formId: "form-1",
  title: "Request a refund",
  description:
    "Tell us what happened. Refunds under $500 are automatic; larger amounts get a quick human review.",
  submitLabel: "Submit request",
  fields: [
    {
      key: "orderId",
      label: "Order ID",
      type: "text",
      required: true,
      placeholder: "#48213",
    },
    {
      key: "amount",
      label: "Amount",
      type: "number",
      required: true,
      placeholder: "1240",
    },
    {
      key: "reason",
      label: "Reason",
      type: "select",
      required: true,
      options: ["Late delivery", "Damaged item", "Wrong item", "Changed mind"],
    },
    {
      key: "details",
      label: "Details",
      type: "textarea",
      placeholder: "Anything else we should know…",
    },
  ],
};

const CHAT_DEF = {
  chatId: "chat-1",
  title: "Northwind Assistant",
  description: "answers from your docs",
  placeholder: "Ask a question…",
  greeting:
    "Hi! I'm Northwind's assistant. Ask me anything about orders, returns, or shipping — I answer from our help docs.",
};

const APPROVAL_PROMPT = {
  awaiting: true,
  title: "Approve $1,240 refund",
  instructions:
    "Customer requested a refund within the policy window. Approving issues the refund via Stripe and closes the ticket.",
};

const meta: Meta = {
  title: "Screens/Public pages",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

/* ===== Hosted form (/f/:formId) ===== */

const formHandlers = [
  http.get("*/api/forms/form-1", () => HttpResponse.json(FORM_DEF)),
  http.post("*/api/forms/form-1", () =>
    HttpResponse.json({ status: "started" }),
  ),
];

/** The pending form card: ember strip, brand tile, real schema fields (text / number / chip
 *  select / textarea), gradient submit, lock footer. */
export const FormPending: Story = {
  name: "Form — pending",
  render: () => <FormPage />,
  parameters: {
    msw: { handlers: formHandlers },
    router: { path: "/f/:formId", initialEntries: ["/f/form-1"] },
  },
};

/** Fill + submit against the mocked endpoint → the green "Request received" success card. */
export const FormSuccess: Story = {
  name: "Form — success",
  render: () => <FormPage />,
  parameters: {
    msw: { handlers: formHandlers },
    router: { path: "/f/:formId", initialEntries: ["/f/form-1"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const order = await canvas.findByLabelText(/Order ID/);
    await userEvent.type(order, "#48213");
    await userEvent.type(canvas.getByLabelText(/Amount/), "1240");
    await userEvent.click(
      canvas.getByRole("button", { name: "Late delivery" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: /Submit request/ }),
    );
    await waitFor(() =>
      expect(canvas.getByText("Request received")).toBeTruthy(),
    );
  },
};

/* ===== Hosted chat (/c/:chatId) ===== */

const chatHandlers = [
  http.get("*/api/chat/chat-1", () => HttpResponse.json(CHAT_DEF)),
  http.post("*/api/chat/chat-1", () =>
    HttpResponse.json({
      status: "replied",
      reply:
        "You can request a refund within 30 days of delivery. Under $500 it's automatic; larger amounts get a quick human review — usually within a few hours.",
    }),
  ),
];

/** The chat card mid-conversation: greeting bot bubble, an ember user bubble, and the graph's
 *  reply (sent through the mocked endpoint by the play function). */
export const ChatThread: Story = {
  name: "Chat — thread",
  render: () => <ChatPage />,
  parameters: {
    msw: { handlers: chatHandlers },
    router: { path: "/c/:chatId", initialEntries: ["/c/chat-1"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Chat message");
    await userEvent.type(input, "How do refunds work?");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(canvas.getByText(/request a refund within 30 days/)).toBeTruthy(),
    );
  },
};

/* ===== Public approve (/approve/:workflowId?token=…) ===== */

function approveHandlers(decision: "approved" | "rejected") {
  return [
    http.get("*/api/approvals/wh-1", () => HttpResponse.json(APPROVAL_PROMPT)),
    http.post("*/api/approvals/wh-1/decide", () =>
      HttpResponse.json({ status: decision }),
    ),
  ];
}

const approveRouter = {
  path: "/approve/:workflowId",
  initialEntries: ["/approve/wh-1?token=tok_demo"],
};

/** The pending decision card: brand tile, review copy, the gate's instructions, comment box,
 *  Approve / Reject, secure-link footer. */
export const ApprovePending: Story = {
  name: "Approve — pending",
  render: () => <ApprovePage />,
  parameters: {
    msw: { handlers: approveHandlers("approved") },
    router: approveRouter,
  },
};

/** Decide → the server records "approved" → the green pop decided state. */
export const ApproveApproved: Story = {
  name: "Approve — approved",
  render: () => <ApprovePage />,
  parameters: {
    msw: { handlers: approveHandlers("approved") },
    router: approveRouter,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const approve = await canvas.findByRole("button", { name: /Approve/ });
    await userEvent.click(approve);
    await waitFor(() =>
      expect(canvas.getByText("Approved — thank you")).toBeTruthy(),
    );
  },
};

/** Decide → the server records "rejected" → the red decided state. */
export const ApproveRejected: Story = {
  name: "Approve — rejected",
  render: () => <ApprovePage />,
  parameters: {
    msw: { handlers: approveHandlers("rejected") },
    router: approveRouter,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reject = await canvas.findByRole("button", { name: /Reject/ });
    await userEvent.click(reject);
    await waitFor(() => expect(canvas.getByText("Rejected")).toBeTruthy());
  },
};
