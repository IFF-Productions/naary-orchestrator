// ── HubSpot (cloud, api.hubapi.com; auth = a private-app access token as a Bearer).
//    Deliberately unprobeable: every read is scope-gated, so a probe would 403 a good token ──
import type { IntegrationProvider } from "../types";

export const HUBSPOT: IntegrationProvider = {
  key: "hubspot",
  label: "HubSpot",
  baseUrl: "https://api.hubapi.com",
  description:
    "Act on HubSpot CRM — get, create, and update contacts; create deals.",
  auth: "A custom connection whose token is a HubSpot private-app access token.",
  unprobeableReason:
    "HubSpot has no identity endpoint a private-app token can call without a scope. The obvious " +
    "candidate — listing contacts — is gated on `crm.objects.contacts.read`, so a token scoped for " +
    "deals only would answer 403 and this check would report a perfectly good connection as a dead " +
    "credential. Test a HubSpot connection with an integration node on a canvas (single-node Test).",
  actions: [
    {
      key: "get_contact",
      label: "Get contact",
      description: "Fetch a single contact by id.",
      method: "GET",
      pathTemplate: "/crm/v3/objects/contacts/{contactId}",
      write: false,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
      ],
    },
    {
      key: "create_contact",
      label: "Create contact",
      description: "Create a new contact.",
      method: "POST",
      pathTemplate: "/crm/v3/objects/contacts",
      write: true,
      fields: [
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
          hint: "contact properties object, e.g. { email, firstname }",
        },
      ],
    },
    {
      key: "update_contact",
      label: "Update contact",
      description: "Update an existing contact by id.",
      method: "PATCH",
      pathTemplate: "/crm/v3/objects/contacts/{contactId}",
      write: true,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
        },
      ],
    },
    {
      key: "create_deal",
      label: "Create deal",
      description: "Create a new deal.",
      method: "POST",
      pathTemplate: "/crm/v3/objects/deals",
      write: true,
      fields: [
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
        },
      ],
    },
  ],
};
