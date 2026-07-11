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
  live smoke test with a real connection — see each provider page.

## Providers

- [GitHub](./github.md) — issues: get, create, comment, add labels.
- [Jira](./jira.md) — tickets: get, create, comment, transition.

More providers are a catalog entry away — see the prioritized backlog in
`docs/design/INTEGRATION-NODES.md §9` (Slack, Linear, Notion, …).
