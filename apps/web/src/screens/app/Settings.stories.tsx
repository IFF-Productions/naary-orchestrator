import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ModeProvider } from "../../mode";
import { WorkspaceProvider } from "../../workspace/WorkspaceProvider";
import { Settings } from "./Settings";

const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
];

/** Env-scoped fixtures — the variables matrix and secrets rows read one env per
 *  request via the X-Environment-Id header, so the handlers branch on it. */
const VARIABLES: Record<string, { key: string; value: string }[]> = {
  "e-sb": [
    { key: "API_BASE_URL", value: "test.api.co" },
    { key: "APPROVAL_THRESHOLD", value: "100" },
    { key: "MAX_RETRIES", value: "1" },
  ],
  "e-uat": [
    { key: "API_BASE_URL", value: "uat.api.co" },
    { key: "APPROVAL_THRESHOLD", value: "500" },
    { key: "MAX_RETRIES", value: "3" },
    { key: "DIGEST_HOUR", value: "6" },
  ],
  "e-prod": [
    { key: "API_BASE_URL", value: "api.co" },
    { key: "APPROVAL_THRESHOLD", value: "25000" },
    { key: "MAX_RETRIES", value: "5" },
    { key: "DIGEST_HOUR", value: "6" },
  ],
};

const SECRETS: Record<string, { name: string }[]> = {
  "e-sb": [{ name: "STRIPE_KEY" }],
  "e-uat": [],
  "e-prod": [
    { name: "DB_URL_ANALYTICS" },
    { name: "OPENAI_KEY" },
    { name: "SLACK_TOKEN" },
    { name: "STRIPE_KEY" },
  ],
};

/** The per-event × channel matrix rows: two Slack webhooks, a disabled Teams row, and an
 *  email list (SMTP connection + recipients) with the promotion column on. */
const CHANNELS = [
  {
    id: "nc-1",
    type: "slack",
    label: "#approvals",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T0/B0/xxx",
    emailConnectionId: null,
    emailTo: [],
    onApprovalPending: true,
    onRunFailed: false,
    onBudgetThreshold: true,
    onPromotion: false,
  },
  {
    id: "nc-2",
    type: "slack",
    label: "#oncall",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T0/B1/yyy",
    emailConnectionId: null,
    emailTo: [],
    onApprovalPending: false,
    onRunFailed: true,
    onBudgetThreshold: false,
    onPromotion: false,
  },
  {
    id: "nc-3",
    type: "teams",
    label: "Ops",
    enabled: false,
    webhookUrl: "https://prod-00.westus.logic.azure.com/workflows/abc",
    emailConnectionId: null,
    emailTo: [],
    onApprovalPending: true,
    onRunFailed: true,
    onBudgetThreshold: false,
    onPromotion: false,
  },
  {
    id: "nc-4",
    type: "email",
    label: "Ops list",
    enabled: true,
    webhookUrl: null,
    emailConnectionId: "conn-smtp-1",
    emailTo: ["ops@acme.io", "oncall@acme.io"],
    onApprovalPending: true,
    onRunFailed: true,
    onBudgetThreshold: false,
    onPromotion: true,
  },
];

/** The environment's connections — the email channel's SMTP picker filters to `smtp`. */
const CONNECTIONS = [
  {
    id: "conn-smtp-1",
    type: "smtp",
    label: "Postmark",
    serverUrl: "smtp.postmarkapp.com",
    authMode: "api_token",
    scopes: [],
    status: "connected",
    createdAt: "2026-07-01T10:00:00.000Z",
  },
  {
    id: "conn-gh-1",
    type: "github",
    label: "GitHub App",
    serverUrl: "https://api.github.com",
    authMode: "oauth",
    scopes: [],
    status: "connected",
    createdAt: "2026-07-01T10:00:00.000Z",
  },
];

const envOf = (request: Request) =>
  request.headers.get("x-environment-id") ?? "e-sb";

const handlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/me/workspaces", () =>
    HttpResponse.json([{ tenantId: "t1", role: "owner", name: "Acme Corp" }]),
  ),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
  http.get("*/api/tenants/:t/settings", () =>
    HttpResponse.json({
      displayName: "Acme Corp",
      defaultModel: "claude-sonnet-4-6",
    }),
  ),
  http.put("*/api/tenants/:t/settings", async ({ request }) =>
    HttpResponse.json(await request.json()),
  ),
  http.put("*/api/me/preferences", () => HttpResponse.json({ ok: true })),
  http.get("*/api/variables", ({ request }) =>
    HttpResponse.json(VARIABLES[envOf(request)] ?? []),
  ),
  http.put("*/api/variables/:key", async ({ params, request }) => {
    const body = (await request.json()) as { value: string };
    return HttpResponse.json({ key: params.key, value: body.value });
  }),
  http.delete(
    "*/api/variables/:key",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.get("*/api/env-secrets", ({ request }) =>
    HttpResponse.json(SECRETS[envOf(request)] ?? []),
  ),
  http.put(
    "*/api/env-secrets/:name",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.delete(
    "*/api/env-secrets/:name",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.get("*/api/tenants/:t/notifications", () => HttpResponse.json(CHANNELS)),
  http.get("*/api/tenants/:t/connections", () =>
    HttpResponse.json(CONNECTIONS),
  ),
  http.post("*/api/tenants/:t/notifications", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ id: "nc-new", ...body });
  }),
  http.patch(
    "*/api/tenants/:t/notifications/:id",
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const prev = CHANNELS.find((c) => c.id === params.id);
      return HttpResponse.json({ ...prev, ...body, id: params.id });
    },
  ),
  http.delete("*/api/tenants/:t/notifications/:id", () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post("*/api/tenants/:t/notifications/:id/test", () =>
    HttpResponse.json({ ok: true }),
  ),
];

const meta: Meta<typeof Settings> = {
  title: "Screens/Settings",
  component: Settings,
  parameters: { layout: "fullscreen", msw: { handlers } },
  decorators: [
    (Story) => (
      <WorkspaceProvider>
        <ModeProvider>
          <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
            <Story />
          </div>
        </ModeProvider>
      </WorkspaceProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Settings>;

/** Default section: write-only secrets across environments (env chips, masked values, kebab). */
export const Secrets: Story = {
  parameters: { router: { initialEntries: ["/app/settings"] } },
};

/** The env-column matrix — Key | sandbox | UAT | prod; cells edit that env's value in place. */
export const Variables: Story = {
  parameters: {
    router: { initialEntries: ["/app/settings?section=variables"] },
  },
};

/** The CREATE path — "Add variable" open, draft row live.
 *
 *  It exists as a story because it had no phone branch and nobody noticed: with `adding` false by
 *  default, no story reached the draft row, so the responsive sweep
 *  (`scripts/responsive-audit.mjs`) measured the edit path only and reported the screen clean
 *  while the draft row laid out 512px of content in a 360px box at 390px (#511). A state the
 *  harness cannot open is a state nobody measures. */
export const VariablesAdding: Story = {
  parameters: {
    router: { initialEntries: ["/app/settings?section=variables"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Re-query inside the wait, every time. The button starts disabled (it needs the per-env
    // variable fetches, which take longer than waitFor's 1s default), and the section remounts
    // as that data lands — so a node captured once goes stale, stays disabled forever, and a
    // click on it silently does nothing. That failure mode is invisible: no error, just a story
    // that renders the state it was written to open.
    const addButton = () =>
      canvas.getByRole("button", { name: /Add variable/ });
    await waitFor(() => expect(addButton()).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(addButton());
    await waitFor(() =>
      expect(canvas.getByPlaceholderText("KEY")).toBeInTheDocument(),
    );
  },
};

/** The per-event × channel matrix — rows are Slack/Teams/email channels, columns the four
 *  real event flags (approval / run failed / budget / promotion); expanding the email row
 *  shows the SMTP connection picker + recipients. */
export const Notifications: Story = {
  parameters: {
    router: { initialEntries: ["/app/settings?section=notifications"] },
  },
};

/** Builder / Simple variant cards + the real workspace defaults (name, default model). */
export const Experience: Story = {
  parameters: {
    router: { initialEntries: ["/app/settings?section=experience"] },
  },
};

/** Empty workspace — no secrets/variables/channels yet; sections teach instead of listing. */
export const Empty: Story = {
  parameters: {
    router: { initialEntries: ["/app/settings"] },
    msw: {
      handlers: [
        http.get("*/api/variables", () => HttpResponse.json([])),
        http.get("*/api/env-secrets", () => HttpResponse.json([])),
        http.get("*/api/tenants/:t/notifications", () => HttpResponse.json([])),
        ...handlers,
      ],
    },
  },
};
