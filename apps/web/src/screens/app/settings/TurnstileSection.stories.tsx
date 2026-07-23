import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { Environment } from "../../../lib/api";
import { TurnstileSection } from "./TurnstileSection";

// The "Bot protection" settings card (Turnstile, Slice 1). MSW stubs GET /turnstile-config so the
// section renders without a backend: Production has a saved config (secret stored → filled
// placeholder + Remove), Sandbox is empty.
const meta: Meta<typeof TurnstileSection> = {
  title: "Settings/TurnstileSection",
};
export default meta;
type Story = StoryObj<typeof TurnstileSection>;

const ENVS: Environment[] = [
  {
    id: "prod",
    name: "Production",
    slug: "prod",
    isDefault: true,
  } as Environment,
  {
    id: "sandbox",
    name: "Sandbox",
    slug: "sandbox",
    isDefault: false,
  } as Environment,
];

const handlers = [
  http.get("*/api/turnstile-config", ({ request }) => {
    const env = request.headers.get("x-environment-id");
    if (env === "prod") {
      return HttpResponse.json({
        siteKey: "0x4AAAAAAABkMYinukE8nzYS",
        enabled: true,
        hasSecret: true,
        allowedHostnames: ["naar-y.com", "forms.naar-y.com"],
      });
    }
    return HttpResponse.json(null); // Sandbox: not configured yet
  }),
];

export const Default: Story = {
  parameters: { msw: { handlers } },
  render: () => (
    <div style={{ maxWidth: 680, padding: 24 }}>
      <TurnstileSection envs={ENVS} />
    </div>
  ),
};
