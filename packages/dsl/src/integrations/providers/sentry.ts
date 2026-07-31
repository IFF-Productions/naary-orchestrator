// ── Sentry (cloud, sentry.io/api/0; auth = a Sentry auth token as a Bearer.
//    `list_organizations` is the credential probe) ─────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const SENTRY: IntegrationProvider = {
  key: "sentry",
  label: "Sentry",
  baseUrl: "https://sentry.io/api/0",
  authScheme: "bearer",
  description:
    "Triage Sentry — list/get issues, resolve or ignore them, list projects.",
  auth: "A custom connection whose token is a Sentry auth token — sent as a Bearer token.",
  actions: [
    {
      key: "list_issues",
      label: "List issues",
      description:
        "List a project's issues, optionally filtered by a search query or time window.",
      method: "GET",
      pathTemplate: "/projects/{organizationSlug}/{projectSlug}/issues/",
      write: false,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
        {
          key: "projectSlug",
          label: "Project slug",
          in: "path",
          required: true,
        },
        {
          key: "query",
          label: "Query",
          in: "query",
          required: false,
          hint: "Sentry search, e.g. is:unresolved",
        },
        {
          key: "statsPeriod",
          label: "Stats period",
          in: "query",
          required: false,
          hint: "e.g. 24h, 14d",
        },
      ],
    },
    // ORG-SCOPED, not the legacy `/issues/{issueId}/` (#946). Both work against the live API, but
    // Sentry's published document contains only this form — so the un-scoped path could never be
    // spec-verified, which is the whole point of pinning a vendor document. The org slug is not
    // derivable from an issue id, so this cannot be back-filled: it is a required field on two
    // actions that authors have already configured. It is the same value `list_issues` and
    // `list_projects` below already ask for, so an author of a Sentry workflow has it to hand.
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch a single issue by id.",
      method: "GET",
      pathTemplate: "/organizations/{organizationSlug}/issues/{issueId}/",
      write: false,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
        { key: "issueId", label: "Issue id", in: "path", required: true },
      ],
    },
    {
      key: "update_issue",
      label: "Update issue",
      description: "Update an issue's status (resolve, ignore, or reopen).",
      method: "PUT",
      pathTemplate: "/organizations/{organizationSlug}/issues/{issueId}/",
      write: true,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
        { key: "issueId", label: "Issue id", in: "path", required: true },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: true,
          hint: "resolved|ignored|unresolved",
        },
      ],
    },
    {
      key: "list_projects",
      label: "List projects",
      description: "List the projects in an organization.",
      method: "GET",
      pathTemplate: "/organizations/{organizationSlug}/projects/",
      write: false,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
      ],
    },
    {
      key: "list_organizations",
      label: "List organizations",
      description:
        "List the organizations this token can see. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/organizations/",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
