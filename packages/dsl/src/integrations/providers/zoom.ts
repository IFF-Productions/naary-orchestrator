// ── Zoom (cloud, api.zoom.us/v2; auth = a server-to-server OAuth access token as a
//    Bearer — those expire in ~1h, so a stored one goes stale and starts 401ing.
//    `get_me` is the credential probe) ─────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const ZOOM: IntegrationProvider = {
  key: "zoom",
  label: "Zoom",
  baseUrl: "https://api.zoom.us/v2",
  authScheme: "bearer",
  description: "Manage Zoom meetings — list, create, get, and delete.",
  auth: "A custom connection whose token is a Zoom server-to-server OAuth access token. NOTE: these tokens are short-lived (~1h) — refresh/rotate the stored token periodically or calls will start failing with 401.",
  actions: [
    {
      key: "list_meetings",
      label: "List meetings",
      description: "List a user's meetings.",
      method: "GET",
      pathTemplate: "/users/{userId}/meetings",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "usually 'me'",
        },
        {
          key: "type",
          label: "Type",
          in: "query",
          required: false,
          hint: "scheduled|live|upcoming",
        },
      ],
    },
    {
      key: "create_meeting",
      label: "Create meeting",
      description: "Schedule a new meeting for a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/meetings",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "usually 'me'",
        },
        { key: "topic", label: "Topic", in: "body", required: true },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: false,
          type: "number",
          hint: "1 instant, 2 scheduled",
        },
        {
          key: "startTime",
          label: "Start time",
          in: "body",
          required: false,
          bodyPath: "start_time",
        },
        {
          key: "duration",
          label: "Duration",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_meeting",
      label: "Get meeting",
      description: "Fetch a meeting by id.",
      method: "GET",
      pathTemplate: "/meetings/{meetingId}",
      write: false,
      fields: [
        { key: "meetingId", label: "Meeting id", in: "path", required: true },
      ],
    },
    {
      key: "delete_meeting",
      label: "Delete meeting",
      description: "Delete a meeting by id.",
      method: "DELETE",
      pathTemplate: "/meetings/{meetingId}",
      write: true,
      fields: [
        { key: "meetingId", label: "Meeting id", in: "path", required: true },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
