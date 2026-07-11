# Jira integration

Manage Jira tickets — read, create, comment, and transition — from a workflow.

## Setup

1. **Create an API token.** At <https://id.atlassian.com/manage-profile/security/api-tokens>,
   create an API token for the Atlassian account that will act. (OAuth also works if your
   connection is set up for it.)
2. **Add the connection.** In **Integrations → Connect a server**:
   - **Type:** Jira / Atlassian
   - **Server URL:** your site, e.g. `https://your-company.atlassian.net` — this becomes the API
     base for the node.
   - **Auth:** the API token (stored as the connection's Bearer token).
3. **Add the Jira node**, pick this connection, choose an action, and fill the fields.

> Cloud only: an Atlassian Cloud site. Self-hosted Jira Data Center on a private network is not
> reachable (egress guard). Calls use the Jira Cloud REST API v2 (plain-string descriptions).

## Actions

| Action | Method | Endpoint | Fields (\* required) |
| --- | --- | --- | --- |
| **Get issue** | GET | `/rest/api/2/issue/{issueKey}` | issueKey\* |
| **Create issue** (write) | POST | `/rest/api/2/issue` | projectKey\*, summary\*, issueType\*, description, priority |
| **Add comment** (write) | POST | `/rest/api/2/issue/{issueKey}/comment` | issueKey\*, body\* |
| **Transition issue** (write) | POST | `/rest/api/2/issue/{issueKey}/transitions` | issueKey\*, transitionId\* |

- **Create issue** assembles the nested Jira payload for you: `projectKey → fields.project.key`,
  `summary → fields.summary`, `issueType → fields.issuetype.name` (e.g. `Bug`/`Task`/`Story`),
  `description → fields.description`, `priority → fields.priority.name`.
- **Transition issue** needs the numeric `transitionId` valid for the ticket's current status
  (list them via *Get issue*'s transitions in Jira, or the transitions API).
- Write actions run **at-most-once** (no auto-retry).

## Output

`{ status, ok, body }` — `status` is the HTTP code (e.g. 201 on create), `body` is Jira's JSON
(the created issue's `key`/`id`). Branch on `<nodeId>.status`.

## Verify it works (live smoke test)

1. Point the connection at a test Jira project.
2. Add a **Jira → Create issue** node with `projectKey`, `summary`, `issueType: Task`; run it.
3. Confirm the ticket appears and the node output shows `status: 201` with the new `key` in
   `body`. Then wire **Add comment** binding `issueKey` to `<create-node>.body.key`.
