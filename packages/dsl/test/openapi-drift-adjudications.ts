/**
 * The ADJUDICATIONS behind `integration-catalog-openapi.drift.spec.ts` — four lists of findings a
 * human has looked at and decided to keep, each with the reason, and each asserted in the spec to
 * STILL be produced.
 *
 * Split out of the spec (#813 wave 2) because this is prose, not logic: the lists grew past the
 * repo's 1000-line file limit while the checks themselves barely moved, and the reasons are the part
 * a reviewer argues with. The both-directions assertions stay in the spec, so nothing here can
 * silence a finding on its own — an entry that no longer matches anything FAILS.
 *
 * The bar for adding one, per list:
 *   ACKNOWLEDGED             — the difference is real and ours to keep (a deliberate field rename, or
 *                              upstream being over-strict in a way no spec can qualify).
 *   UNSPECIFIED              — the provider's own spec omits an endpoint they document elsewhere.
 *                              Live evidence (401 vs 404) is expected, not optional.
 *   ACKNOWLEDGED_BODY        — the spec is wrong or incomplete about a field we send on purpose.
 *   ACKNOWLEDGED_REQUIRED_BODY — the provider's document contradicts ITSELF about a requirement.
 */

/**
 * Findings of class (4) we have looked at and decided to keep. Each MUST still be produced —
 * an acknowledgment that no longer matches anything is either a fixed catalog entry whose note
 * was left behind, or upstream having changed its mind. Both deserve a look.
 */
export const ACKNOWLEDGED: { finding: string; why: string }[] = [
  {
    finding:
      'pagerduty.create_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — required only for an account-level (General Access) key; a user-scoped key must NOT send it. No spec can express 'conditional on the key you hold'.",
  },
  {
    finding:
      'pagerduty.acknowledge_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'pagerduty.resolve_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'pagerduty.add_note: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'stripe.get_customer: path field "customerId" ↔ upstream "customer"',
    why: 'Deliberate rename: a config panel labelled "customer" reads as the customer OBJECT, not its id. Substitution is positional, so the name is ours to choose.',
  },
  {
    finding: 'twilio.get_message: path field "messageSid" ↔ upstream "Sid"',
    why: 'Deliberate rename: Twilio calls every id "Sid"; the action already has an accountSid, so an unqualified "Sid" would be ambiguous in the UI.',
  },
  {
    finding:
      'cloudflare.delete_dns_record: path field "recordId" ↔ upstream "dns_record_id"',
    why: 'Deliberate rename: the action is already scoped to DNS records, so the "dns_record_" prefix is noise in a config panel. Substitution is positional.',
  },
  {
    finding: 'discord.add_reaction: path field "emoji" ↔ upstream "emoji_name"',
    why: 'Deliberate rename: the segment takes either a unicode emoji or a custom `name:id`, so "emoji" describes the input better than upstream\'s "emoji_name".',
  },
  {
    finding: 'posthog.get_person: path field "personId" ↔ upstream "id"',
    why: 'Deliberate rename: a bare "id" in a config panel is ambiguous when the same action also takes a projectId.',
  },
  {
    finding:
      'box.create_folder: body "parent.id" is required upstream and reaches the API only inside the free-form JSON field "parent"',
    why: 'By design: `parent` is a `type: "json"` field whose hint is `{ "id": "0" } for root`. Splitting it into a scalar `parent.id` would drop the other keys Box accepts there.',
  },
  {
    finding:
      'sendgrid.send_mail: body "from.email" is required upstream and reaches the API only inside the free-form JSON field "from"',
    why: 'By design: `from` is a `type: "json"` field hinted `{ email, name? }`. The v3 Mail Send body is deeply structured (personalizations/content are arrays), so the whole envelope is authored as JSON.',
  },
  {
    finding: 'gitlab.create_issue: path field "projectId" ↔ upstream "id"',
    why: 'Deliberate rename: GitLab calls every scoping segment "id", so a bare "id" beside "issueIid" in a config panel says nothing. Substitution is positional.',
  },
  {
    finding: 'gitlab.get_issue: path field "projectId" ↔ upstream "id"',
    why: "Deliberate rename — same reason as create_issue.",
  },
  {
    finding: 'gitlab.list_issues: path field "projectId" ↔ upstream "id"',
    why: "Deliberate rename — same reason as create_issue.",
  },
  {
    finding: 'gitlab.comment_issue: path field "projectId" ↔ upstream "id"',
    why: "Deliberate rename — same reason as create_issue.",
  },
  {
    finding:
      'gitlab.comment_issue: path field "issueIid" ↔ upstream "noteable_id"',
    why: 'GitLab shares one Notes route across issues, merge requests and snippets, so its spec names the segment generically. Ours is bound to issues, where GitLab\'s own docs call the value the "issue iid".',
  },
  {
    finding:
      'jira.add_comment: path field "issueKey" ↔ upstream "issueIdOrKey"',
    why: 'Deliberate rename: the field hint asks for a key ("PROJ-123"). Jira accepts a numeric id there too, but offering both in a config panel invites pasting the wrong one. Substitution is positional.',
  },
  {
    finding: 'jira.get_issue: path field "issueKey" ↔ upstream "issueIdOrKey"',
    why: "Deliberate rename — same reason as add_comment.",
  },
  {
    finding:
      'jira.transition_issue: path field "issueKey" ↔ upstream "issueIdOrKey"',
    why: "Deliberate rename — same reason as add_comment.",
  },
  {
    finding: 'calendly.cancel_event: path field "eventUuid" ↔ upstream "uuid"',
    why: 'Deliberate rename: Calendly names every path segment "uuid", and the action also reads an event, so an unqualified "uuid" says nothing about WHICH object. The field key is what authors bind expressions to, so it stays ours.',
  },
  {
    finding: 'calendly.get_event: path field "eventUuid" ↔ upstream "uuid"',
    why: "Deliberate rename — same reason as cancel_event.",
  },
  // Sentry, arriving with #946. All five are the same difference: Sentry's document spells its two
  // path segments `organization_id_or_slug` / `project_id_or_slug`, we spell them `organizationSlug`
  // / `projectSlug`. Substitution is POSITIONAL, so the names never have to agree — and these field
  // keys are what authors bind expressions to, so they stay in the catalog's own camelCase house
  // style rather than switching to snake_case for one provider.
  {
    finding:
      'sentry.get_issue: path field "organizationSlug" ↔ upstream "organization_id_or_slug"',
    why: 'Deliberate rename: Sentry accepts a numeric org id OR a slug in this segment and names it for both. Our field asks for the slug specifically — the value an author has in front of them in the Sentry URL — and offering "id or slug" in a config panel invites pasting the wrong one. Same reasoning as jira.issueKey.',
  },
  {
    finding:
      'sentry.update_issue: path field "organizationSlug" ↔ upstream "organization_id_or_slug"',
    why: "Deliberate rename — same reason as get_issue.",
  },
  {
    finding:
      'sentry.list_issues: path field "organizationSlug" ↔ upstream "organization_id_or_slug"',
    why: "Deliberate rename — same reason as get_issue. Predates #946; it only becomes visible now that Sentry has a pinned fixture to be compared against.",
  },
  {
    finding:
      'sentry.list_projects: path field "organizationSlug" ↔ upstream "organization_id_or_slug"',
    why: "Deliberate rename — same reason as get_issue. Predates #946.",
  },
  {
    finding:
      'sentry.list_issues: path field "projectSlug" ↔ upstream "project_id_or_slug"',
    why: "Deliberate rename — same reason as get_issue, one level down: the project segment takes an id or a slug too, and the field asks for the slug. Predates #946.",
  },
];

/**
 * Actions with no upstream operation, on purpose. Empty today — an entry here is a claim that the
 * provider's own spec omits an endpoint they document elsewhere, which needs a reason, not a
 * shrug. (Refreshing the fixture is nearly always the right fix instead.)
 */
export const UNSPECIFIED: { action: string; why: string }[] = [
  {
    action: "asana.get_me",
    why:
      "Asana's OAS models the user read as `/users/{user_gid}` only; `me` is a documented magic " +
      "gid, not a distinct operation, so the literal path can never appear in the spec. Verified " +
      "live: unauthenticated `GET https://app.asana.com/api/1.0/users/me` → 401, not 404 — the " +
      "endpoint exists and is reachable, which is what the connection probe needs.",
  },
  {
    action: "posthog.get_me",
    why:
      "PostHog's schema is generated from DRF and omits this route; `@me` is a viewset alias " +
      "rather than a registered path. Verified live: unauthenticated " +
      "`GET https://app.posthog.com/api/users/@me/` → 401, not 404.",
  },
  {
    action: "mattermost.get_me",
    why:
      "Mattermost models the current-user read as `/users/{user_id}` with the documented magic id " +
      "`me`, so the literal path is not a separate operation. Verified live against Mattermost's " +
      "own community server: `GET https://community.mattermost.com/api/v4/users/me` → 401 while " +
      "`/api/v4/nonsense` → 404.",
  },
  {
    action: "zoom.get_me",
    why:
      "Same `me` sentinel: Zoom's `GET /users/{userId}` says outright to pass `me` in place of " +
      "the id. Verified live: `GET https://api.zoom.us/v2/users/me` → 401, `/v2/nonsense` → 404.",
  },
  {
    action: "hubspot.create_deal",
    why:
      "HubSpot's Deals document templates every path on the internal objectTypeId — " +
      "`/crm/v3/objects/0-3`, never the word `deals` (which appears in the file only inside an " +
      "`externalDocs` link). The runtime accepts the name: `POST " +
      "https://api.hubapi.com/crm/v3/objects/deals` → 401 while `/crm/v3/nonsense-xyz` → 404. " +
      "The generic CRM Objects document has `/crm/v3/objects/{objectType}`, but binding a LITERAL " +
      "segment of ours to a PLACEHOLDER of theirs would make `{}` match anything and quietly " +
      "un-check every path in this file.",
  },
];

/**
 * WRONG body paths (#813) we have adjudicated and decided to keep — one per (action, field), and
 * each must STILL be produced, asserted below in the same both-directions way as ACKNOWLEDGED. An
 * entry is a claim that the spec is wrong or incomplete about a field we send on purpose; it is
 * not a place to park a finding nobody wanted to read.
 */
export const ACKNOWLEDGED_BODY: {
  action: string;
  field: string;
  why: string;
}[] = [
  {
    action: "msgraph.send_mail",
    field: "message",
    why:
      "Microsoft's OpenAPI is generated from CSDL, where the action's parameters are declared " +
      "`Message` and `SaveToSentItems`; the WIRE names are camelCase. Microsoft's own reference " +
      "(learn.microsoft.com/graph/api/user-sendmail, Request body table + all five HTTP examples) " +
      'documents `{"message": {…}, "saveToSentItems": "false"}`. Their docs beat their generator.',
  },
  {
    action: "msgraph.send_mail",
    field: "saveToSentItems",
    why: "Same CSDL-PascalCase artifact as `message` — see that entry.",
  },
];

/**
 * Sentry's `PUT …/issues/{issue_id}/` marks EVERY property of a partial update required (#946).
 *
 * The operation contradicts itself in its own two sentences. Its `description` reads:
 *
 *   > "Update an individual issue's attributes. Only the attributes submitted are modified."
 *
 * while its schema carries `required: ["assignedTo","discard","hasSeen","inbox","isBookmarked",
 * "isPublic","isSubscribed","merge","priority","status","statusDetails","substatus"]` — all twelve.
 *
 * It is also unsatisfiable as written, which is the part that does not depend on reading the prose
 * charitably. `merge` ("if true, merges the issues together") and `discard` ("if true, discards the
 * issues instead of updating them") are opposite operations, and the nested `statusDetails` requires
 * `inRelease`, `inNextRelease` AND all five `ignore*` fields (`ignoreCount`, `ignoreDuration`,
 * `ignoreUserCount`, `ignoreUserWindow`, `ignoreWindow`) at once — alternative resolution targets.
 * No request can satisfy this schema, so no catalog could be written to satisfy it either; a request
 * that DID send all twelve would be the broken one.
 *
 * Systematic, not specific to this route: 9 of Sentry's 63 documented write bodies mark every
 * property required, which is the signature of a generator emitting `required` from the property
 * list rather than from the API's actual contract.
 *
 * Same class as the HubSpot entry below and PagerDuty's readOnly-yet-required service reference
 * (#813) — the document neither confirms nor denies, so it is not evidence of a catalog bug. What
 * we DO send (`status`) is the one field the action exists to set, and it is spec-confirmed.
 */
const SENTRY_PARTIAL_UPDATE =
  "Sentry marks all 12 properties of a PARTIAL update required while the same operation's " +
  'description reads "Only the attributes submitted are modified" — and the set is unsatisfiable ' +
  "anyway (`merge` and `discard` are opposite operations; `statusDetails` requires `inRelease`, " +
  "`inNextRelease` and all five `ignore*` fields simultaneously). A generator artifact: 9 of Sentry's " +
  "63 write bodies mark every property required. Re-derived on every " +
  "`pnpm refresh:openapi-fixtures`, so if Sentry fixes it this entry stops matching.";

/**
 * The required-but-unsent paths, listed EXPLICITLY rather than matched by prefix: the argument above
 * is about this schema's twelve properties, and a wildcard would silently adopt any property Sentry
 * adds later. A new one should fail the build and be looked at.
 */
const SENTRY_UPDATE_ISSUE_UNSENT = [
  "assignedTo",
  "discard",
  "hasSeen",
  "inbox",
  "isBookmarked",
  "isPublic",
  "isSubscribed",
  "merge",
  "priority",
  "statusDetails",
  "statusDetails.ignoreCount",
  "statusDetails.ignoreDuration",
  "statusDetails.ignoreUserCount",
  "statusDetails.ignoreUserWindow",
  "statusDetails.ignoreWindow",
  "statusDetails.inNextRelease",
  "statusDetails.inRelease",
  "substatus",
];

/**
 * Required body properties we do NOT supply, adjudicated. The sibling of ACKNOWLEDGED_BODY for
 * check (3) rather than (5), and held to the same bar: an entry is a claim that the provider's own
 * document contradicts ITSELF about the requirement, quoted, not a place to silence a red test.
 * "Upstream says required and we simply don't send it" is a catalog bug — fix it (see
 * `clickup.create_comment`'s `notify_all`, added as a `const` for exactly this reason).
 */
export const ACKNOWLEDGED_REQUIRED_BODY: {
  action: string;
  path: string;
  why: string;
}[] = [
  {
    action: "hubspot.create_contact",
    path: "associations",
    why:
      "HubSpot's document contradicts itself in one schema: `SimplePublicObjectInputForCreate` " +
      'lists `required: ["associations", "properties"]` while its own `description` reads "the ' +
      "properties to be set and OPTIONAL associations to link the new record with other CRM " +
      "objects\". Same class as PagerDuty's readOnly-yet-required service reference (#813): the " +
      "spec neither confirms nor denies, so it is not evidence of a catalog bug. Re-derived on " +
      "every `pnpm refresh:openapi-fixtures`, so if HubSpot resolves it this entry stops matching.",
  },
  ...SENTRY_UPDATE_ISSUE_UNSENT.map((path) => ({
    action: "sentry.update_issue",
    path,
    why: SENTRY_PARTIAL_UPDATE,
  })),
];
