import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { FormPage } from "./FormPage";

// The public hosted form WITH a Cloudflare Turnstile bot gate (Slice 2). MSW returns a definition
// carrying `turnstileSiteKey`; a stub for `window.turnstile` stands in for Cloudflare's script (which
// can't load offline) — clicking it solves the challenge, which enables the otherwise-disabled submit.
const meta: Meta<typeof FormPage> = {
  title: "Public/FormPage (Turnstile)",
  component: FormPage,
};
export default meta;
type Story = StoryObj<typeof FormPage>;

// Stand in for Cloudflare's Turnstile script: render a clickable box that "solves" on click.
const withTurnstileStub: Decorator = (Story) => {
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (
      el: HTMLElement,
      opts: { callback: (t: string) => void },
    ): string => {
      el.innerHTML = "";
      const box = document.createElement("button");
      box.type = "button";
      box.textContent = "✓ Verify you are human (demo widget)";
      box.style.cssText =
        "padding:10px 14px;border:1px solid #4a4a4a;border-radius:8px;background:#151515;color:#ddd;cursor:pointer;font-size:13px";
      box.onclick = () => opts.callback("demo-token");
      el.appendChild(box);
      return "widget-1";
    },
    remove: () => {},
    reset: () => {},
  };
  return <Story />;
};

const handlers = [
  http.get("*/api/forms/demo", () =>
    HttpResponse.json({
      formId: "demo",
      title: "Contact us",
      description: "We'll get back to you shortly.",
      submitLabel: "Send request",
      fields: [
        { key: "email", label: "Email", type: "email", required: true },
        { key: "message", label: "Message", type: "textarea" },
      ],
      turnstileSiteKey: "0xTESTSITEKEY",
    }),
  ),
];

/** Submit is DISABLED until the Turnstile challenge is solved (click the demo widget to enable it). */
export const Gated: Story = {
  parameters: {
    msw: { handlers },
    router: { path: "/f/:formId", initialEntries: ["/f/demo"] },
  },
  decorators: [withTurnstileStub],
};
