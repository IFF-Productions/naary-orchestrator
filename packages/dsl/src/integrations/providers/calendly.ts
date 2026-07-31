// ── Calendly (cloud, api.calendly.com; auth = a personal access token as a Bearer) ────
import type { IntegrationProvider } from "../types";

export const CALENDLY: IntegrationProvider = {
  key: "calendly",
  label: "Calendly",
  baseUrl: "https://api.calendly.com",
  description:
    "Read your Calendly account — who am I, list/get scheduled events, cancel an event.",
  auth: "A custom connection whose token is a Calendly personal access token — sent as a Bearer token.",
  actions: [
    {
      key: "get_me",
      label: "Get current user",
      description: "Fetch the authenticated user (your user URI).",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      fields: [],
    },
    {
      key: "list_events",
      label: "List scheduled events",
      description:
        "List scheduled events for a user, optionally filtered by status.",
      method: "GET",
      pathTemplate: "/scheduled_events",
      write: false,
      fields: [
        {
          key: "user",
          label: "User",
          in: "query",
          required: true,
          hint: "user URI",
        },
        {
          key: "status",
          label: "Status",
          in: "query",
          required: false,
          hint: "active|canceled",
        },
        {
          key: "count",
          label: "Count",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_event",
      label: "Get scheduled event",
      description: "Fetch a single scheduled event by UUID.",
      method: "GET",
      pathTemplate: "/scheduled_events/{eventUuid}",
      write: false,
      fields: [
        { key: "eventUuid", label: "Event UUID", in: "path", required: true },
      ],
    },
    {
      key: "cancel_event",
      label: "Cancel scheduled event",
      description: "Cancel a scheduled event, with an optional reason.",
      method: "POST",
      pathTemplate: "/scheduled_events/{eventUuid}/cancellation",
      write: true,
      fields: [
        { key: "eventUuid", label: "Event UUID", in: "path", required: true },
        { key: "reason", label: "Reason", in: "body", required: false },
      ],
    },
  ],
};
