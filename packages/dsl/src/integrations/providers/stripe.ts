// ── Stripe (cloud, api.stripe.com/v1; auth = a secret key `sk_live_…`/`sk_test_…` as a
//    Bearer). Its writes are `bodyEncoding: "form"` — Stripe rejects a JSON body outright,
//    so they failed 100% of the time until #707 ────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const STRIPE: IntegrationProvider = {
  key: "stripe",
  label: "Stripe",
  baseUrl: "https://api.stripe.com/v1",
  authScheme: "bearer",
  description:
    "Act on Stripe — create/get customers, create payment intents, list charges, refund.",
  auth: "A custom connection whose token is a Stripe secret key (`sk_live_…` / `sk_test_…`), sent as a Bearer token.",
  credentialSetup: {
    tokenUrl: "https://dashboard.stripe.com/apikeys",
    steps: [
      "In the Stripe dashboard open Developers → API keys and copy or create a secret key.",
      "Start in test mode (`sk_test_…`) and keep that key in your sandbox environment — test and live data are separate worlds.",
      "Prefer a restricted key limited to the resources this workflow needs.",
    ],
    // Authored rather than derived: the bearer sentence is true but says nothing about the trap,
    // which is pasting the publishable key.
    tokenFormat:
      "Paste the SECRET key (`sk_test_…` / `sk_live_…`) on its own — the publishable `pk_…` key will not work. `Bearer ` is added for you.",
  },
  actions: [
    {
      key: "create_customer",
      label: "Create customer",
      description: "Create a new customer.",
      method: "POST",
      pathTemplate: "/customers",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        { key: "email", label: "Email", in: "body", required: false },
        { key: "name", label: "Name", in: "body", required: false },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "get_customer",
      label: "Get customer",
      description: "Fetch a single customer by id.",
      method: "GET",
      pathTemplate: "/customers/{customerId}",
      write: false,
      fields: [
        {
          key: "customerId",
          label: "Customer id",
          in: "path",
          required: true,
          hint: "e.g. cus_XXXXXXXXXXXXXX",
        },
      ],
    },
    {
      key: "create_payment_intent",
      label: "Create payment intent",
      description: "Create a payment intent to collect a payment.",
      method: "POST",
      pathTemplate: "/payment_intents",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "amount",
          label: "Amount",
          in: "body",
          required: true,
          type: "number",
          hint: "in the smallest currency unit, e.g. 1999 = $19.99",
        },
        {
          key: "currency",
          label: "Currency",
          in: "body",
          required: true,
          hint: "ISO code, e.g. usd",
        },
        {
          key: "customer",
          label: "Customer",
          in: "body",
          required: false,
          hint: "customer id, e.g. cus_…",
        },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "list_charges",
      label: "List charges",
      description: "List charges, optionally filtered by customer.",
      method: "GET",
      pathTemplate: "/charges",
      write: false,
      fields: [
        {
          key: "customer",
          label: "Customer",
          in: "query",
          required: false,
          hint: "filter by customer id",
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "1–100 (default 10)",
        },
      ],
    },
    {
      key: "create_refund",
      label: "Create refund",
      description: "Refund a charge, fully or partially.",
      method: "POST",
      pathTemplate: "/refunds",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "charge",
          label: "Charge",
          in: "body",
          required: true,
          hint: "charge id, e.g. ch_…",
        },
        {
          key: "amount",
          label: "Amount",
          in: "body",
          required: false,
          type: "number",
          hint: "in the smallest currency unit; omit for a full refund",
        },
      ],
    },
  ],
};
