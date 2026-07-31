// ── PostHog (cloud, app.posthog.com; auth = a personal API key as a Bearer.
//    `get_me` is the credential probe) ─────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const POSTHOG: IntegrationProvider = {
  key: "posthog",
  label: "PostHog",
  baseUrl: "https://app.posthog.com",
  authScheme: "bearer",
  description:
    "Read PostHog analytics — list events and persons, get a person, add an annotation.",
  auth: "A custom connection whose token is a PostHog personal API key — sent as a Bearer token.",
  actions: [
    {
      key: "list_events",
      label: "List events",
      description: "List recent events for a project.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/events/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
      ],
    },
    {
      key: "list_persons",
      label: "List persons",
      description: "List persons for a project, optionally filtered by search.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/persons/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "search", label: "Search", in: "query", required: false },
      ],
    },
    {
      key: "get_person",
      label: "Get person",
      description: "Fetch a single person by id.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/persons/{personId}/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "personId", label: "Person id", in: "path", required: true },
      ],
    },
    {
      key: "create_annotation",
      label: "Create annotation",
      description: "Add an annotation to a project.",
      method: "POST",
      pathTemplate: "/api/projects/{projectId}/annotations/",
      write: true,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "date_marker",
          label: "Date marker",
          in: "body",
          required: false,
          hint: "ISO timestamp the annotation marks",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this personal API key belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/api/users/@me/",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
