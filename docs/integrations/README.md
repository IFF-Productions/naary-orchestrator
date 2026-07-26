# Integrations

Native **integration nodes** let a workflow act on an external service — GitHub, Jira, … —
through a curated set of actions, authenticated by a **connection** you set up once. Under the
hood they are the `integration` node (design: `docs/design/INTEGRATION-NODES.md`); the palette
shows one tile per provider.

## How they work (the shape every integration shares)

1. **Create a connection** in **Integrations → Connect a server** (or the connections API) for the
   provider, with its auth (a token or OAuth) and — for site-based providers like Jira — the
   **Server URL**. The token is encrypted at rest and only ever decrypted inside the activity;
   it never enters the graph, workflow history, or logs.
2. **Drop the provider's node** onto the canvas (e.g. **GitHub**, **Jira**).
3. **Pick the connection and the action** (e.g. *Create issue*).
4. **Fill the fields** — statically, or **bind** a field to an upstream step's output
   (`{ from: <nodeId>, path: <dotted.path> }`), e.g. the issue number from a trigger or a title
   from an agent.
5. The node outputs `{ status, ok, body }` — branch on `<nodeId>.status` (the HTTP code) just like
   the HTTP Request node.

## Reads vs. writes

- **Read** actions (e.g. *Get issue*) are idempotent and retry on a transient failure.
- **Write** actions (create / comment / transition) run **at-most-once** — a transient failure
  **fails the node** rather than risk creating a duplicate (a lost response after the provider
  already applied the change). Re-run deliberately if needed.

## Native node vs. MCP Tool

- Use a **native integration node** for a first-class provider we curate (GitHub, Jira): a fixed,
  discoverable action set with typed fields, no extra infrastructure.
- Use the **MCP Tool** node to call an *arbitrary* tool on an MCP server you run — open-ended, for
  anything not (yet) in the catalog.

## Limits

- **Cloud only.** The egress guard blocks private hosts, so **GitHub Enterprise Server** and
  **self-hosted Jira** on private networks are not reachable. Cloud GitHub (`api.github.com`) and
  Atlassian Cloud sites work.
- **Verification.** Request construction (method / URL / body / auth) is unit-tested against the
  catalog. Whether the provider *accepts* a call (token scopes, API changes) is confirmed by a
  live smoke test with a real connection — see each provider page. For the 14 providers with a
  non-write, zero-argument read, **Test connection** on the Integrations screen answers "does this
  token work?" in one click, through the same request builder the node uses
  (`VERIFICATION.md` §1.5, coverage table §2.4).

## Providers

Every provider has a setup guide: what credential you need, where to get it, how to connect it,
how to verify it, its full action list, and its traps. The pages are **generated from the catalog**
(`pnpm gen:integration-docs`) so the action tables cannot drift from what the node actually sends —
see `packages/dsl/src/docs/render.ts` for which sections are generated and which are hand-written.

For how any of this gets verified — and an honest account of what has *never* been called against a
real API — see **[VERIFICATION.md](./VERIFICATION.md)**, which also covers the non-catalog
integrations (SQL, SMTP, MCP, LLM providers, notification channels) and the operator-side ones.

<!-- BEGIN GENERATED PROVIDER INDEX (pnpm gen:integration-docs) -->

### Analytics

- **[PostHog](./posthog.md)** — Query PostHog events and people, and annotate releases, from a workflow. <sub>(not live-verified)</sub>

### Communication

- **[Discord](./discord.md)** — Post messages, open DMs and react in Discord from a workflow. <sub>(not live-verified)</sub>
- **[Front](./front.md)** — Read Front conversations and add internal comments from a workflow. <sub>(not live-verified)</sub>
- **[Intercom](./intercom.md)** — Look up Intercom contacts and send messages or notes from a workflow. <sub>(not live-verified)</sub>
- **[Mattermost](./mattermost.md)** — Post to Mattermost channels and read recent posts from a workflow. <sub>(needs a Server URL, not live-verified)</sub>
- **[Slack](./slack.md)** — Post and update Slack messages, and react to them, from a workflow. <sub>(not live-verified)</sub>
- **[Twilio](./twilio.md)** — Send SMS and place voice calls from a workflow. <sub>(not live-verified)</sub>
- **[Zendesk](./zendesk.md)** — Read, create and update Zendesk tickets from a workflow. <sub>(needs a Server URL, not live-verified)</sub>
- **[Zoom](./zoom.md)** — Create, list and cancel Zoom meetings from a workflow. <sub>(not live-verified)</sub>

### Data & Storage

- **[Airtable](./airtable.md)** — Read and write Airtable records as workflow steps. <sub>(not live-verified)</sub>
- **[Box](./box.md)** — List, fetch and organise Box files and folders from a workflow. <sub>(not live-verified)</sub>
- **[Dropbox](./dropbox.md)** — List, inspect and organise Dropbox files from a workflow. <sub>(not live-verified)</sub>
- **[Google Sheets](./googlesheets.md)** — Read and append Google Sheets rows as workflow steps. <sub>(not live-verified)</sub>

### Developer Tools

- **[Cloudflare](./cloudflare.md)** — Manage Cloudflare zones and DNS records from a workflow. <sub>(not live-verified)</sub>
- **[DigitalOcean](./digitalocean.md)** — Create and manage DigitalOcean droplets from a workflow. <sub>(not live-verified)</sub>
- **[Netlify](./netlify.md)** — Inspect Netlify sites and deploys from a workflow. <sub>(not live-verified)</sub>
- **[PagerDuty](./pagerduty.md)** — Raise, acknowledge and resolve PagerDuty incidents from a workflow. <sub>(not live-verified)</sub>
- **[Sentry](./sentry.md)** — Triage Sentry issues from a workflow — list, inspect, resolve. <sub>(not live-verified)</sub>
- **[Vercel](./vercel.md)** — Inspect Vercel projects and deployments from a workflow. <sub>(not live-verified)</sub>

### Development

- **[GitHub](./github.md)** — Read, create, comment on and label GitHub issues and pull requests from a workflow.
- **[GitLab](./gitlab.md)** — Read and file GitLab issues, and comment on them, from a workflow. <sub>(not live-verified)</sub>
- **[Jira](./jira.md)** — Read, create, comment on and transition Jira issues from a workflow. <sub>(needs a Server URL, not live-verified)</sub>
- **[Linear](./linear.md)** — File, update and comment on Linear issues from a workflow. <sub>(not live-verified)</sub>

### Finance & Accounting

- **[Shopify](./shopify.md)** — Read and manage Shopify products and orders from a workflow. <sub>(needs a Server URL, not live-verified)</sub>
- **[Stripe](./stripe.md)** — Create customers, take payments and issue refunds from a workflow. <sub>(not live-verified)</sub>

### Marketing

- **[Mailchimp](./mailchimp.md)** — Add and update Mailchimp audience members, and create campaigns. <sub>(needs a Server URL, not live-verified)</sub>
- **[SendGrid](./sendgrid.md)** — Send transactional email and manage contacts via SendGrid. <sub>(not live-verified)</sub>
- **[Webflow](./webflow.md)** — Read and create Webflow CMS collection items from a workflow. <sub>(not live-verified)</sub>

### Productivity

- **[Asana](./asana.md)** — Create and update Asana tasks, and comment on them, from a workflow. <sub>(not live-verified)</sub>
- **[Calendly](./calendly.md)** — Read your Calendly schedule and cancel bookings from a workflow. <sub>(not live-verified)</sub>
- **[ClickUp](./clickup.md)** — Create, update and comment on ClickUp tasks from a workflow. <sub>(not live-verified)</sub>
- **[Microsoft Graph](./msgraph.md)** — Read and send Outlook mail and manage calendar events via Microsoft Graph. <sub>(not live-verified)</sub>
- **[Monday.com](./monday.md)** — Create and update monday.com items and post updates from a workflow. <sub>(not live-verified)</sub>
- **[Notion](./notion.md)** — Read, query and create Notion pages and database rows — a common knowledge-base source for RAG, and an output sink for AI workflows. <sub>(not live-verified)</sub>
- **[Todoist](./todoist.md)** — Create, list and close Todoist tasks from a workflow. <sub>(not live-verified)</sub>

### Sales (CRM)

- **[HubSpot](./hubspot.md)** — Create and update HubSpot contacts and deals from a workflow. <sub>(not live-verified)</sub>
- **[Pipedrive](./pipedrive.md)** — Create and update Pipedrive deals and people from a workflow. <sub>(not live-verified)</sub>

### Utility

- **[DeepL](./deepl.md)** — Translate text mid-workflow and keep an eye on your character quota. <sub>(needs a Server URL, not live-verified)</sub>

<!-- END GENERATED PROVIDER INDEX -->

More providers are a catalog entry away — see the prioritized backlog in
`docs/design/INTEGRATION-NODES.md §9`.
