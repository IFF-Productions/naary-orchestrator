/**
 * HAND-MAINTAINED prose for the per-provider setup guides in `docs/integrations/`.
 *
 * This file is the ONLY hand-written half of those pages. Everything mechanical — the action
 * table, the auth-scheme sentence, whether a Server URL is required, whether Test Connection can
 * probe the provider — is derived from `INTEGRATION_PROVIDERS` by `render.ts`, so it cannot drift
 * from the catalog. (It already had: `docs/integrations/github.md` listed 4 of GitHub's 5 catalog
 * actions before this generator existed.)
 *
 * What belongs HERE: the things a machine cannot know — where in a provider's console the token
 * lives, which scopes it needs, and the traps that cost someone an afternoon.
 * What does NOT belong here: anything already in the catalog. If you find yourself repeating an
 * endpoint or a header name, delete it and let the renderer emit it.
 *
 * Console paths: named at the AREA level (e.g. "Settings → API") rather than as a deep click
 * path, deliberately. Provider consoles get reorganised often, we cannot re-verify 38 of them,
 * and a confidently wrong menu path wastes more time than a slightly vague correct one.
 */

/** One provider's hand-written half. */
export interface IntegrationProse {
  /** One sentence, user-facing — the "why would I use this" line. Reused as the page's lede. */
  tagline: string;
  /** Marketing/gallery grouping. Matches the category issues (#624–#637). */
  category: string;
  /** What the secret is CALLED on the provider's side — the phrase to look for in their console. */
  credentialName: string;
  /** Where to get it. Area-level, 2–4 steps. */
  steps: string[];
  /** Scopes / permissions the token needs, when the provider has a scope model. */
  scopes?: string;
  /** Required Server URL format — set ONLY for providers the catalog gives no `baseUrl`. */
  serverUrl?: string;
  /** Traps. Anything that makes a correct-looking setup fail. */
  gotchas?: string[];
  /**
   * A concrete first-run walkthrough, for providers where "call a read action" isn't obvious enough
   * to be useful — e.g. chaining a create into a comment so the reader sees how binding works.
   * Optional: most providers are adequately served by the generated single-node Test paragraph.
   */
  verifyExample?: string[];
}

export const INTEGRATION_PROSE: Record<string, IntegrationProse> = {
  airtable: {
    tagline: "Read and write Airtable records as workflow steps.",
    category: "Data & Storage",
    credentialName: "personal access token",
    steps: [
      "Open your Airtable **developer hub → Personal access tokens** and create a token.",
      "Grant it the data scopes below **and** add the specific base(s) it may touch — a token with no base added returns 403 on every call.",
      "Copy the token immediately; Airtable shows it once.",
    ],
    scopes:
      "`data.records:read`, plus `data.records:write` for the write actions",
    gotchas: [
      "`baseId` starts with `app…` and `tableId` with `tbl…`. A table *name* works in place of `tableId` but breaks the moment someone renames the table — prefer the id.",
      "Access is per-base: adding the scope is not enough, the base itself must be added to the token.",
    ],
  },
  asana: {
    tagline:
      "Create and update Asana tasks, and comment on them, from a workflow.",
    category: "Productivity",
    credentialName: "personal access token",
    steps: [
      "Open your Asana **developer console** (My Apps) and create a personal access token.",
      "Copy it at creation time — it is not shown again.",
    ],
    gotchas: [
      "`taskGid` and `projects` take Asana **GIDs** (long numeric strings), not names. The GID of a task is the number in its URL.",
      "The token inherits your own permissions, so it can only reach workspaces you are a member of.",
    ],
  },
  box: {
    tagline: "List, fetch and organise Box files and folders from a workflow.",
    category: "Data & Storage",
    credentialName: "access token",
    steps: [
      "In the **Box Developer Console**, create an app and generate an access token for it.",
      "Authorise the app in your Box admin settings if your enterprise requires it.",
    ],
    gotchas: [
      "Developer-console tokens are **short-lived (~1 hour)**. For anything unattended, mint a token from a server-side OAuth/JWT flow and refresh it, or the workflow starts 401ing after an hour of working.",
      "Folder `0` is the root folder — that is Box's convention, not a placeholder.",
    ],
  },
  calendly: {
    tagline: "Read your Calendly schedule and cancel bookings from a workflow.",
    category: "Productivity",
    credentialName: "personal access token",
    steps: [
      "In Calendly, open **Integrations → API & webhooks** and create a personal access token.",
    ],
    gotchas: [
      "Most endpoints want a **user URI**, not an email — call *Get current user* first and bind its `resource.uri` into the later steps.",
    ],
  },
  clickup: {
    tagline: "Create, update and comment on ClickUp tasks from a workflow.",
    category: "Productivity",
    credentialName: "personal API token (`pk_…`)",
    steps: [
      "In ClickUp, open your **personal Settings → Apps** and generate an API token.",
    ],
    gotchas: [
      "ClickUp wants the token in a **bare `Authorization` header with no `Bearer ` prefix**. Naary handles that for you — but it is why a token that works here fails if you paste it into a generic HTTP node with `Bearer`.",
      "`listId` and `taskId` are numeric strings from the task URL.",
    ],
  },
  cloudflare: {
    tagline: "Manage Cloudflare zones and DNS records from a workflow.",
    category: "Developer Tools",
    credentialName: "API token",
    steps: [
      "In the Cloudflare dashboard, open **My Profile → API Tokens** and create a token.",
      "Scope it to the specific zone(s) it should manage rather than all zones.",
      "Prefer a scoped **API token** over the legacy Global API Key, which cannot be limited and authenticates differently.",
    ],
    scopes: "`Zone:Read`, plus `DNS:Edit` for the DNS write actions",
    gotchas: [
      "The legacy Global API Key uses `X-Auth-Email` + `X-Auth-Key` headers and will **not** work here — use an API token.",
    ],
  },
  deepl: {
    tagline:
      "Translate text mid-workflow and keep an eye on your character quota.",
    category: "Utility",
    credentialName: "DeepL auth key",
    steps: [
      "Open your **DeepL account → API keys** and copy the authentication key.",
      "Note which plan the key belongs to — Free and Pro use **different hosts** (below).",
    ],
    serverUrl:
      "`https://api-free.deepl.com` for a Free key, `https://api.deepl.com` for Pro",
    gotchas: [
      "Using the wrong host for your plan returns 403 with a valid key — this is the single most common DeepL setup failure. Free keys end in `:fx`.",
      "*Get usage* is the cheapest way to confirm the key works: it takes no arguments and consumes no characters.",
    ],
  },
  digitalocean: {
    tagline: "Create and manage DigitalOcean droplets from a workflow.",
    category: "Developer Tools",
    credentialName: "personal access token",
    steps: [
      "In the DigitalOcean control panel, open **API → Tokens** and generate a personal access token.",
      "Give it **write** scope only if the workflow needs to create or destroy droplets.",
    ],
    gotchas: [
      "*Delete droplet* is irreversible and destroys data. Gate it behind a human-approval node.",
    ],
  },
  discord: {
    tagline: "Post messages, open DMs and react in Discord from a workflow.",
    category: "Communication",
    credentialName: "bot token",
    steps: [
      "In the **Discord Developer Portal**, create an application and add a **Bot** to it.",
      "Copy the bot token from the Bot page (reset it if it was never revealed).",
      "Invite the bot to your server with the permissions it needs, then enable **Developer Mode** in Discord to copy channel IDs.",
    ],
    scopes:
      "bot permissions: *Send Messages*, plus *Add Reactions* / *Read Message History* for those actions",
    gotchas: [
      "The token goes in `Authorization: Bot <token>` — Discord's own scheme, neither Bearer nor bare. Naary applies it for you.",
      "A bot that has not been **invited to the server** authenticates fine and then 403s on every channel. Inviting is a separate step from creating.",
      "IDs are snowflakes (long numeric strings), copied via Developer Mode → *Copy ID*.",
    ],
  },
  dropbox: {
    tagline: "List, inspect and organise Dropbox files from a workflow.",
    category: "Data & Storage",
    credentialName: "access token",
    steps: [
      "In the **Dropbox App Console**, create an app with the Scoped Access model.",
      "Set its permissions, then generate an access token on the app's Settings tab.",
    ],
    scopes:
      "`files.metadata.read`, plus `files.content.write` for write actions",
    gotchas: [
      "Generated access tokens are **short-lived** unless you use a refresh-token flow — expect 401s on a long-lived workflow.",
      'The root folder is the **empty string** `""`, not `/`. Paths are like `/Reports/2026`.',
      "Dropbox's list/metadata endpoints are `POST` even though they only read. That is why they are still safe to call.",
    ],
  },
  front: {
    tagline:
      "Read Front conversations and add internal comments from a workflow.",
    category: "Communication",
    credentialName: "API token",
    steps: [
      "In Front, open **Settings → Developers** and create an API token.",
    ],
    gotchas: [
      "*Add comment* writes an **internal** note, visible to teammates — it does not reply to the customer.",
    ],
  },
  github: {
    tagline:
      "Read, create, comment on and label GitHub issues and pull requests from a workflow.",
    category: "Development",
    credentialName: "personal access token, or a GitHub App installation token",
    steps: [
      "In GitHub, open **Settings → Developer settings → Personal access tokens** and create a token — classic with `repo`, or fine-grained with **Issues: Read and write** on the target repos.",
      "A **GitHub App** installation token also works, and is the better choice for an organisation: it is scoped per-repo and rotates automatically. Naary can install a GitHub App for you from the Integrations screen.",
    ],
    scopes:
      "classic: `repo` · fine-grained: *Issues: Read and write* (add *Pull requests: Read* for the PR action)",
    gotchas: [
      "**Cloud only.** `api.github.com` works; GitHub Enterprise Server on a private network is blocked by the egress guard.",
      "A fine-grained token must have the specific repository added to it — the scope alone is not enough.",
    ],
    verifyExample: [
      "Point the connection's token at a throwaway repo you own.",
      "Add a **Create issue** node, set `owner`/`repo` and a static `title`, and run it.",
      "Confirm the issue appears and the output shows `status: 201` with the new `number` in `body`.",
      "Then chain **Comment on issue**, binding its `issueNumber` to `<create-node>.body.number` — that is the pattern for every provider: create, then bind the returned id.",
    ],
  },
  gitlab: {
    tagline:
      "Read and file GitLab issues, and comment on them, from a workflow.",
    category: "Development",
    credentialName: "personal access token",
    steps: [
      "In GitLab, open **Preferences → Access tokens** and create a personal access token.",
    ],
    scopes: "`api` (the narrower `read_api` cannot create or comment)",
    gotchas: [
      "`projectId` is either the numeric project id or the **URL-encoded** path (`group%2Fproject`). A raw `group/project` breaks the URL.",
      "Issues have two numbers: use the `iid` (the one shown in the UI), not the global `id`.",
      "Self-managed GitLab on a private network is blocked by the egress guard.",
    ],
  },
  googlesheets: {
    tagline: "Read and append Google Sheets rows as workflow steps.",
    category: "Data & Storage",
    credentialName: "Google OAuth access token",
    steps: [
      "In **Google Cloud Console**, enable the Google Sheets API for your project.",
      "Create OAuth credentials (or a service account) and obtain an **access token** for the spreadsheets scope.",
      "If you use a service account, **share the spreadsheet with the service-account email** — otherwise every call 403s.",
    ],
    scopes: "`https://www.googleapis.com/auth/spreadsheets`",
    gotchas: [
      "A Google **API key will not work.** API keys travel in a `?key=` query parameter, which this node never sends. It must be an OAuth access token.",
      "Google access tokens expire in about an hour — refresh or rotate for unattended workflows.",
      "`spreadsheetId` is the long id in the sheet's URL between `/d/` and `/edit`. Ranges are A1 notation (`Sheet1!A1:C10`).",
    ],
  },
  hubspot: {
    tagline: "Create and update HubSpot contacts and deals from a workflow.",
    category: "Sales (CRM)",
    credentialName: "private app access token",
    steps: [
      "In HubSpot, open **Settings → Integrations → Private apps** and create a private app.",
      "Select its CRM scopes, then copy the access token.",
    ],
    scopes:
      "`crm.objects.contacts.write`, `crm.objects.deals.write` (and their `.read` pairs)",
    gotchas: [
      "Legacy **API keys were retired** — a private-app token is the only supported option.",
      "Fields go inside a `properties` object, using HubSpot's internal property names (`firstname`, not `First Name`).",
    ],
  },
  intercom: {
    tagline:
      "Look up Intercom contacts and send messages or notes from a workflow.",
    category: "Communication",
    credentialName: "access token",
    steps: [
      "In the **Intercom Developer Hub**, create an app for your workspace and copy its access token.",
    ],
    gotchas: [
      "`contactId` is Intercom's internal id, not an email — search for the contact first if all you have is an address.",
    ],
  },
  jira: {
    tagline:
      "Read, create, comment on and transition Jira issues from a workflow.",
    category: "Development",
    credentialName: "Atlassian API token, paired with your account email",
    steps: [
      "Create an API token in your **Atlassian account security settings** (Manage account → Security → API tokens).",
      "Combine it as `your-email@company.com:your-api-token` — Naary sends that pair as HTTP Basic.",
      "Alternatively connect via Atlassian OAuth (3LO) from the Integrations screen, which avoids handling a token at all.",
    ],
    serverUrl: "your Atlassian site, e.g. `https://your-company.atlassian.net`",
    gotchas: [
      "The credential is **email + token**, not the token alone. A token on its own returns 401.",
      "*Transition issue* needs a `transitionId`, which is workflow-specific — read the issue's available transitions first; the id is not the status name.",
      "Self-hosted Jira Data Center on a private network is blocked by the egress guard.",
      "`issueType` takes the type NAME (`Bug`, `Task`, `Story`), not an id.",
    ],
    verifyExample: [
      "Point the connection at a test Jira project.",
      "Add a **Create issue** node with `projectKey`, `summary` and `issueType: Task`, and run it.",
      "Confirm the ticket exists and the output shows `status: 201` with the new `key` in `body`.",
      "Then chain **Add comment**, binding `issueKey` to `<create-node>.body.key`.",
    ],
  },
  linear: {
    tagline: "File, update and comment on Linear issues from a workflow.",
    category: "Development",
    credentialName: "personal API key",
    steps: [
      "In Linear, open **Settings → API → Personal API keys** and create a key.",
    ],
    gotchas: [
      "Linear is **GraphQL-only** — every action posts a query to one endpoint, so the `query` field is required even for reads.",
      "Ids are UUIDs. Use the team/project ids from the API, not the human-readable keys.",
    ],
  },
  mailchimp: {
    tagline: "Add and update Mailchimp audience members, and create campaigns.",
    category: "Marketing",
    credentialName: "API key",
    steps: [
      "In Mailchimp, open **Account → Extras → API keys** and create a key.",
      "Read the **datacenter suffix** off the end of the key (e.g. `…-us19` → `us19`) — you need it for the Server URL.",
    ],
    serverUrl:
      "`https://{dc}.api.mailchimp.com/3.0`, where `{dc}` is your key's datacenter suffix (e.g. `us19`)",
    gotchas: [
      "The datacenter in the URL must match the one in your key, or every call 401s with a perfectly valid key.",
      "`listId` is the Audience ID from **Audience → Settings**.",
      "Mailchimp keys members by the MD5 hash of the lowercased email — the *Add member* action handles that, but a hand-built HTTP call would not.",
    ],
  },
  mattermost: {
    tagline:
      "Post to Mattermost channels and read recent posts from a workflow.",
    category: "Communication",
    credentialName: "personal access token or bot token",
    steps: [
      "Ask a Mattermost admin to enable personal access tokens (**System Console → Integrations**) if they are off.",
      "Create a bot account under **Integrations → Bot Accounts** (preferred) or a personal access token in your own **Security** settings.",
    ],
    serverUrl: "your Mattermost base URL, e.g. `https://chat.your-company.com`",
    gotchas: [
      "**Self-hosted, and the egress guard blocks private addresses.** A Mattermost on an internal-only network is not reachable from Naary — it must resolve to a public host.",
      "The bot must be **added to the channel** it posts in.",
    ],
  },
  monday: {
    tagline:
      "Create and update monday.com items and post updates from a workflow.",
    category: "Productivity",
    credentialName: "API token",
    steps: [
      "In monday.com, open **Administration → Connections → API** (or your avatar → Developers → My access tokens) and copy the token.",
    ],
    gotchas: [
      "monday.com wants the token in a **bare `Authorization` header, no `Bearer ` prefix**. Naary does that for you.",
      "It is **GraphQL-only** — one endpoint, and the `query` field is required even for reads.",
      "Board and item ids are numbers; `change_column_value` needs the column's **id**, not its title.",
    ],
  },
  msgraph: {
    tagline:
      "Read and send Outlook mail and manage calendar events via Microsoft Graph.",
    category: "Productivity",
    credentialName: "Microsoft Graph OAuth access token",
    steps: [
      "Register an application in **Microsoft Entra ID (Azure AD) → App registrations**.",
      "Add the Graph permissions below and grant admin consent.",
      "Obtain an access token for the app (client-credentials flow for unattended use).",
    ],
    scopes: "`Mail.Read`, `Mail.Send`, `Calendars.ReadWrite` as required",
    gotchas: [
      "Graph access tokens last about an hour — plan for rotation on any unattended workflow.",
      "`userId` is the user's object id or UPN. `me` only works for delegated (user) tokens, never for application tokens.",
      "Application permissions reach the **whole tenant** unless you scope them — a mail-send app can send as anyone.",
    ],
  },
  netlify: {
    tagline: "Inspect Netlify sites and deploys from a workflow.",
    category: "Developer Tools",
    credentialName: "personal access token",
    steps: [
      "In Netlify, open **User settings → Applications → Personal access tokens** and create one.",
    ],
  },
  notion: {
    tagline:
      "Read, query and create Notion pages and database rows — a common knowledge-base source for RAG, and an output sink for AI workflows.",
    category: "Productivity",
    credentialName: "internal integration token (`secret_…` / `ntn_…`)",
    steps: [
      "Create an integration at **notion.so/my-integrations** and copy its internal integration token.",
      "In Notion, open each page or database the workflow touches and **share it with the integration** — via the `…` menu → Connections.",
    ],
    gotchas: [
      '**Sharing is the step everyone misses.** A valid token returns 404 for any page the integration has not been added to — Notion does not distinguish "forbidden" from "does not exist".',
      "Ids are the UUIDs in the page/database URL (with or without dashes).",
      "Creating a page requires a `parent` and `properties` matching the target database's schema exactly.",
    ],
    verifyExample: [
      "Create a scratch page in Notion and share it with the integration (`…` → Connections).",
      "Add a **Get page** node with that page's id and run it.",
      "A 404 here almost always means the sharing step was missed, not that the id is wrong — Notion returns 404 rather than 403 for pages the integration cannot see.",
    ],
  },
  pagerduty: {
    tagline:
      "Raise, acknowledge and resolve PagerDuty incidents from a workflow.",
    category: "Developer Tools",
    credentialName: "REST API key",
    steps: [
      "In PagerDuty, open **Integrations → API Access Keys** and create a REST API key.",
      "Note whether it is account-scoped or user-scoped — that decides whether you must send a `From` address.",
    ],
    gotchas: [
      "The header is `Authorization: Token token=<key>` — PagerDuty's own scheme, not a Bearer. Naary applies it.",
      "Write actions need a **`From` header set to a PagerDuty user's login email** unless the key is user-scoped. Without it you get 400.",
      "Creating an incident **pages a human.** Use a test service while you are wiring the workflow up.",
    ],
  },
  pipedrive: {
    tagline: "Create and update Pipedrive deals and people from a workflow.",
    category: "Sales (CRM)",
    credentialName: "API token",
    steps: [
      "In Pipedrive, open **Personal preferences → API** and copy your personal API token.",
    ],
    gotchas: [
      "Pipedrive's docs usually show the token as an `?api_token=` query parameter; Naary sends it as a Bearer instead, which their API also accepts.",
    ],
  },
  posthog: {
    tagline:
      "Query PostHog events and people, and annotate releases, from a workflow.",
    category: "Analytics",
    credentialName: "personal API key",
    steps: [
      "In PostHog, open **Settings → Personal API keys** and create a key.",
      "Note your **project id** from the project settings — most endpoints need it.",
    ],
    gotchas: [
      "A personal API key is **not** the same as the project write-only key used by the tracking SDKs. The SDK key will not work here.",
      "Self-hosted PostHog needs its own Server URL and must be publicly resolvable.",
    ],
  },
  sendgrid: {
    tagline: "Send transactional email and manage contacts via SendGrid.",
    category: "Marketing",
    credentialName: "API key",
    steps: [
      "In SendGrid, open **Settings → API Keys** and create a key with the access below.",
      "Verify a sender identity (**Settings → Sender Authentication**) — SendGrid rejects mail from unverified senders.",
    ],
    scopes: "*Mail Send* at minimum; add *Marketing* for the contacts action",
    gotchas: [
      "An unverified `from` address fails with 403 even though the key is valid. Sender verification is a separate step.",
      "*Send mail* takes SendGrid's nested `personalizations` shape — usually easier to build in a `set` node and bind in.",
      "For ordinary transactional mail, Naary's own `sendEmail` node over SMTP is simpler; use SendGrid when you want their templates and analytics.",
    ],
  },
  sentry: {
    tagline: "Triage Sentry issues from a workflow — list, inspect, resolve.",
    category: "Developer Tools",
    credentialName: "auth token",
    steps: [
      "In Sentry, open **Settings → Auth Tokens** (organisation-level for CI use) and create a token.",
    ],
    scopes:
      "`project:read`, `event:read`, plus `event:write` to resolve or ignore issues",
    gotchas: [
      "Sentry's own DSN is **not** an auth token — the DSN sends events in, tokens read them back out.",
      "Self-hosted Sentry needs its own Server URL.",
    ],
  },
  shopify: {
    tagline: "Read and manage Shopify products and orders from a workflow.",
    category: "Finance & Accounting",
    credentialName: "Admin API access token",
    steps: [
      "In your Shopify admin, open **Settings → Apps and sales channels → Develop apps** and create an app.",
      "Configure its Admin API scopes, install it on the store, then reveal the **Admin API access token**.",
    ],
    scopes: "`read_products`/`write_products`, `write_orders` as required",
    gotchas: [
      "The token goes in an `X-Shopify-Access-Token` header, not `Authorization`. Naary handles it — but it is why the token fails in a generic HTTP node configured for Bearer.",
      "The Server URL embeds an **API version** that Shopify ages out roughly quarterly; a working integration can break on a version sunset. Check the version if calls start 400ing.",
    ],
    serverUrl:
      "`https://{your-store}.myshopify.com/admin/api/2024-01` — substitute your store handle, and check the API version is still supported",
  },
  slack: {
    tagline:
      "Post and update Slack messages, and react to them, from a workflow.",
    category: "Communication",
    credentialName: "bot user OAuth token (`xoxb-…`)",
    steps: [
      "Create an app at **api.slack.com/apps** for your workspace.",
      "Under **OAuth & Permissions**, add the bot token scopes below, install the app, and copy the **Bot User OAuth Token**.",
      "Invite the bot into each channel it will post in (`/invite @your-app`).",
    ],
    scopes: "`chat:write`, plus `reactions:write` for the reaction action",
    gotchas: [
      "A bot that has not been invited to the channel gets `not_in_channel` — inviting is separate from installing.",
      "Slack answers `200 OK` even when the call **failed**: the real result is `body.ok`. Branch on `<nodeId>.body.ok`, not on `status`.",
      "Channel can be an id (`C0…`, stable) or `#name` (breaks when renamed). Prefer the id.",
      "For run notifications and approval buttons, use a **notification channel** instead — that path is already built and has a send-test.",
    ],
    verifyExample: [
      "Create a scratch channel and invite the bot to it.",
      "Add a **Post message** node with that `channel` and any `text`, and run it.",
      "Confirm the message appears and the output shows `body.ok: true` with a `ts`.",
      "Then chain **Add reaction**, binding `timestamp` to `<post-node>.body.ts`.",
    ],
  },
  stripe: {
    tagline:
      "Create customers, take payments and issue refunds from a workflow.",
    category: "Finance & Accounting",
    credentialName: "secret key (`sk_test_…` / `sk_live_…`)",
    steps: [
      "In the Stripe dashboard, open **Developers → API keys** and copy a **secret** key.",
      "Start with a **test-mode** key (`sk_test_…`) and keep it in your sandbox environment.",
      "Prefer a restricted key limited to the resources the workflow needs.",
    ],
    gotchas: [
      "The publishable key (`pk_…`) will not work — it must be the secret key.",
      "**Live keys move real money.** Use Naary's per-environment connections: `sk_test_…` in sandbox, `sk_live_…` in prod, so a sandbox run can never charge a customer.",
      "*Create refund* is irreversible. Gate it behind human approval.",
    ],
  },
  todoist: {
    tagline: "Create, list and close Todoist tasks from a workflow.",
    category: "Productivity",
    credentialName: "API token",
    steps: [
      "In Todoist, open **Settings → Integrations → Developer** and copy your API token.",
    ],
  },
  twilio: {
    tagline: "Send SMS and place voice calls from a workflow.",
    category: "Communication",
    credentialName: "Account SID and Auth Token",
    steps: [
      "Copy the **Account SID** and **Auth Token** from your Twilio Console dashboard.",
      "Combine them as `AccountSid:AuthToken` — Naary sends that as HTTP Basic.",
      "Buy or verify a sending phone number under **Phone Numbers**.",
    ],
    gotchas: [
      "**The write actions are currently broken — see issue #707.** `send_sms` and `make_call` send a JSON body, and Twilio's REST API requires form-encoding, so both are rejected. The read actions work. This is a known bug, not a setup mistake on your side.",
      "Set the node's `accountSid` field **as well as** the connection token: the URL path needs it explicitly and it is not derived from the credential.",
      "Trial accounts can only message **verified** numbers.",
      "Automated SMS and voice are legally regulated (consent, quiet hours, AI-voice disclosure). See `docs/design/OUTBOUND-VOICE-CALL.md` before running anything at volume.",
    ],
  },
  vercel: {
    tagline: "Inspect Vercel projects and deployments from a workflow.",
    category: "Developer Tools",
    credentialName: "access token",
    steps: [
      "In Vercel, open **Account Settings → Tokens** and create an access token.",
      "Scope it to the right team if the projects belong to one.",
    ],
    gotchas: [
      "Team-owned projects need a token scoped to that team, or the calls return empty rather than failing loudly.",
      "*Delete deployment* is irreversible.",
    ],
  },
  webflow: {
    tagline: "Read and create Webflow CMS collection items from a workflow.",
    category: "Marketing",
    credentialName: "site API token",
    steps: [
      "In Webflow, open the site's **Settings → Apps & integrations** and generate an API token.",
    ],
    gotchas: [
      "Created items are **staged, not published** — a separate publish step makes them live.",
      "`siteId` and `collectionId` come from the API or the site settings, not the editor URL.",
    ],
  },
  zendesk: {
    tagline: "Read, create and update Zendesk tickets from a workflow.",
    category: "Communication",
    credentialName: "API token, paired with your agent email",
    steps: [
      "In Zendesk Admin Center, open **Apps and integrations → APIs → Zendesk API** and enable **token access**, then add an API token.",
      "Combine it as `your-email@company.com/token:your-api-token` — Naary sends that as HTTP Basic.",
    ],
    serverUrl: "`https://{your-subdomain}.zendesk.com/api/v2`",
    gotchas: [
      "The credential format is unusual: the literal string `/token` sits between your email and the token. Getting it wrong is the usual cause of a 401 here.",
      "Token access is **off by default** — enabling it is a separate admin step.",
    ],
  },
  zoom: {
    tagline: "Create, list and cancel Zoom meetings from a workflow.",
    category: "Communication",
    credentialName: "server-to-server OAuth access token",
    steps: [
      "In the **Zoom App Marketplace**, create a **Server-to-Server OAuth** app.",
      "Add the meeting scopes, activate the app, then request an access token with its credentials.",
    ],
    scopes: "`meeting:read`, `meeting:write`",
    gotchas: [
      "**Tokens expire in about an hour.** Zoom issues no long-lived token for this app type, so a stored token will start 401ing — rotate it, or expect scheduled workflows to fail after the first hour.",
      "`userId` is the Zoom user id or email; `me` works only for the token's own user.",
    ],
  },
};
