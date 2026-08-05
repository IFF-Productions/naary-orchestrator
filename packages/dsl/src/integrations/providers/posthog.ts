// ── PostHog (base = the CONNECTION's serverUrl, because PostHog's host is REGIONAL:
//    us.posthog.com for US Cloud, eu.posthog.com for EU Cloud, and self-hosted has its own.
//    PostHog's docs are explicit that requests must go to the right one. Auth = a personal
//    API key as a Bearer; `get_me` is the credential probe) ────────────────────────────
import type { IntegrationProvider } from "../types";

export const POSTHOG: IntegrationProvider = {
  key: "posthog",
  label: "PostHog",
  baseUrlFromConnection: true,
  // WHY A FALLBACK, AND WHY THIS VALUE (#1110). Until now the catalog hardcoded
  // `https://app.posthog.com`, so every existing PostHog connection was made without ever being
  // asked for a host — and a `Connection` row records no provider key (it is a `custom`
  // connection with a user-chosen label), so a migration has no way to tell PostHog's rows from
  // anyone else's and backfill them. Making the host connection-supplied with no fallback would
  // therefore fix EU/self-hosted tenants by breaking every US tenant that works today, which is a
  // strictly worse trade. So an empty serverUrl keeps calling US Cloud, which is where the old
  // `app.posthog.com` resolves — unchanged behaviour for everyone who works today, a host field
  // for everyone who doesn't. (A connection that DID store `app.posthog.com` also keeps calling
  // exactly the host it calls today; this change never rewrites a value a user typed.)
  defaultBaseUrl: "https://us.posthog.com",
  serverUrlExample: "https://us.posthog.com or https://eu.posthog.com",
  authScheme: "bearer",
  description:
    "Read PostHog analytics — list events and persons, get a person, add an annotation.",
  auth: "A custom connection whose Server URL is your PostHog region's host (https://us.posthog.com for US Cloud, https://eu.posthog.com for EU Cloud, or your own host if self-hosted) and whose token is a PostHog personal API key — sent as a Bearer token. Left blank, US Cloud is assumed.",
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
