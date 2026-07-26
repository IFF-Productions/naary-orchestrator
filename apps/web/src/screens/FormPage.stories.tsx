import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { FormPage } from "./FormPage";

// The public hosted form WITH a Cloudflare Turnstile bot gate. MSW returns a definition carrying
// `botGate` (and the deprecated `turnstileSiteKey` alongside it, exactly as the server does for one
// release); a stub for `window.turnstile` stands in for Cloudflare's script (which can't load
// offline) — clicking it solves the challenge, which enables the otherwise-disabled submit.
//
// The second story pins the OTHER shape: an older API that sends only `turnstileSiteKey`. That is
// the compatibility direction that matters (a fresh bundle against a lagging API) and the one whose
// failure is silent — no gate rendered, no token sent, every submission 403'd.
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
      botGate: { provider: "turnstile", siteKey: "0xTESTSITEKEY" },
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

// A plain form (no bot gate) for the embed comparison.
const plainHandlers = [
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
    }),
  ),
];

/** `?embed=1` — chrome-less render for embedding in an iframe (Slice 1): the full-page striped
 *  background + centering are dropped so the card sits flush + transparent inside the host frame. */
export const Embedded: Story = {
  parameters: {
    msw: { handlers: plainHandlers },
    router: { path: "/f/:formId", initialEntries: ["/f/demo?embed=1"] },
  },
};

/** The same form NOT embedded — full public-page chrome, for comparison. */
export const Standalone: Story = {
  parameters: {
    msw: { handlers: plainHandlers },
    router: { path: "/f/:formId", initialEntries: ["/f/demo"] },
  },
};

// ---------------------------------------------------------------------------------------------
// Branding (successTitle/successMessage, accentColor, theme, desktopColumns, width, redirectUrl).
// Every key is optional and the stories above are the unbranded baseline — comparing them is the
// point: an unset branding block must render byte-identically to the pre-branding page.
// ---------------------------------------------------------------------------------------------

/** A longer field set, so the two-column layout has something to pair up. */
const BRANDED_FIELDS = [
  { key: "first", label: "First name", type: "text", required: true },
  { key: "last", label: "Last name", type: "text", required: true },
  { key: "email", label: "Work email", type: "email", required: true },
  { key: "company", label: "Company", type: "text" },
  { key: "seats", label: "Seats", type: "number" },
  {
    key: "plan",
    label: "Plan",
    type: "select",
    options: ["Starter", "Growth", "Enterprise"],
  },
  { key: "message", label: "Anything else?", type: "textarea" },
];

const brandedHandlers = (branding: Record<string, unknown>) => [
  http.get("*/api/forms/demo", () =>
    HttpResponse.json({
      formId: "demo",
      title: "Request a demo",
      description: "Tell us a little about your team.",
      submitLabel: "Request demo",
      fields: BRANDED_FIELDS,
      branding,
    }),
  ),
  // 202, so submitting in the story reaches the success card.
  http.post("*/api/forms/demo", () => HttpResponse.json({ status: "started" })),
];

const brandedStory = (branding: Record<string, unknown>): Story => ({
  parameters: {
    msw: { handlers: brandedHandlers(branding) },
    router: { path: "/f/:formId", initialEntries: ["/f/demo"] },
  },
});

/**
 * A blue accent on a wide two-column card. Note the SUBMIT BUTTON: `EMBER_BUTTON` hardcodes its
 * gradient rather than reading `var(--brand)`, so `accentButton` has to override it — without that the
 * strip and focus rings would recolour while the most prominent control stayed orange.
 *
 * Long-answer and choice fields keep a full row on purpose (a paragraph box in half a row is worse
 * than no columns), and phones always collapse to one column.
 */
export const BrandedTwoColumn = brandedStory({
  accentColor: "#3355ff",
  desktopColumns: 2,
  width: "wide",
  successTitle: "Thanks — we're on it",
  successMessage:
    "Someone from the team will reach out within one business day.",
});

/**
 * A PALE accent, which is the readability trap: with the stock light ink this button would be
 * white-on-near-white. `readableInkOn` picks dark ink from the accent's own luminance instead.
 */
export const BrandedPaleAccent = brandedStory({
  accentColor: "#ffe066",
  successTitle: "Got it!",
});

/** Forced light presentation regardless of the visitor's own theme. */
export const BrandedForcedLight = brandedStory({
  accentColor: "#12a594",
  theme: "light",
  desktopColumns: 2,
  width: "wide",
});

/** Forced dark, same accent — the pair shows the theme is genuinely scoped to the page wrapper. */
export const BrandedForcedDark = brandedStory({
  accentColor: "#12a594",
  theme: "dark",
  desktopColumns: 2,
  width: "wide",
});

/**
 * Embedded WITH a redirect configured. Submitting shows the success card plus a "Continue" link
 * rather than navigating: auto-navigating would either strand the visitor inside a frame with no URL
 * bar, or frame-bust the host page on its behalf. Submit this one to see it.
 */
export const BrandedEmbeddedRedirect: Story = {
  parameters: {
    msw: {
      handlers: brandedHandlers({
        accentColor: "#8b5cf6",
        redirectUrl: "https://example.com/thank-you",
        successTitle: "Submitted",
      }),
    },
    router: { path: "/f/:formId", initialEntries: ["/f/demo?embed=1"] },
  },
};

/**
 * A tenant logo replacing the Naary mark in the header. The `src` points at OUR origin
 * (`/api/forms/assets/:id`) — the branding carries an opaque ASSET ID, never a tenant-supplied URL, so
 * a hosted form never fetches an image from an address we don't control. MSW answers with a tiny
 * inline PNG here; in the app the bytes come from S3 via the asset route.
 */
export const BrandedWithLogo: Story = {
  parameters: {
    msw: {
      handlers: [
        ...brandedHandlers({
          accentColor: "#12a594",
          logoAssetId: "9f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
          logoAlt: "Acme",
          successTitle: "Thanks!",
        }),
        // A 1x1 teal PNG, so the story is self-contained (no network, no fixture file).
        http.get("*/api/forms/assets/*", () => {
          const png = Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            ),
            (c) => c.charCodeAt(0),
          );
          return new HttpResponse(png, {
            headers: { "content-type": "image/png" },
          });
        }),
      ],
    },
    router: { path: "/f/:formId", initialEntries: ["/f/demo"] },
  },
};

/**
 * An OLDER API: only the deprecated `turnstileSiteKey`, no `botGate`. `resolveBotGate` must still
 * produce a Turnstile gate — this renders and behaves identically to `Gated` above.
 */
export const LegacyApiWithoutBotGate: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/forms/demo", () =>
          HttpResponse.json({
            formId: "demo",
            title: "Contact us",
            description: "We'll get back to you shortly.",
            submitLabel: "Send request",
            fields: [
              { key: "email", label: "Email", type: "email", required: true },
            ],
            turnstileSiteKey: "0xTESTSITEKEY",
          }),
        ),
      ],
    },
    router: { path: "/f/:formId", initialEntries: ["/f/demo"] },
  },
  decorators: [withTurnstileStub],
};
