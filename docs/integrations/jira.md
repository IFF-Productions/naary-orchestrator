---
title: 'Read, create, comment on and transition Jira issues from a workflow.'
provider: jira
label: 'Jira'
category: 'Development'
authType: basic
serverUrlRequired: true
actionCount: 4
writeActionCount: 3
oneClickTestable: false
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Jira

Read, create, comment on and transition Jira issues from a workflow.

## Before you start

- **You need:** an Atlassian API token, paired with your account email.
- **How the token is sent:** HTTP Basic — Naary base64-encodes the credential pair for you. Paste the raw `user:secret` pair, not a pre-encoded string.
- **Server URL: required.** your Atlassian site, e.g. `https://your-company.atlassian.net` Getting this wrong is the most common cause of a setup that looks right and 404s.

## Get your credentials

1. Create an API token in your **Atlassian account security settings** (Manage account → Security → API tokens).
2. Combine it as `your-email@company.com:your-api-token` — Naary sends that pair as HTTP Basic.
3. Alternatively connect via Atlassian OAuth (3LO) from the Integrations screen, which avoids handling a token at all.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Jira** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to your Atlassian site, e.g. `https://your-company.atlassian.net`.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** its read actions all need an id you have to supply, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Jira** node, pick this connection, choose a read action and fill its ids, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

A concrete first run:

1. Point the connection at a test Jira project.
2. Add a **Create issue** node with `projectKey`, `summary` and `issueType: Task`, and run it.
3. Confirm the ticket exists and the output shows `status: 201` with the new `key` in `body`.
4. Then chain **Add comment**, binding `issueKey` to `<create-node>.body.key`.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Get issue | `GET` | `/rest/api/2/issue/{issueKey}` | `issueKey` | — |
| **Create issue** (write) | `POST` | `/rest/api/2/issue` | `projectKey`, `summary`, `issueType` | `description`, `priority` |
| **Add comment** (write) | `POST` | `/rest/api/2/issue/{issueKey}/comment` | `issueKey`, `body` | — |
| **Transition issue** (write) | `POST` | `/rest/api/2/issue/{issueKey}/transitions` | `issueKey`, `transitionId` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Create issue**: `projectKey` → `fields.project.key`, `summary` → `fields.summary`, `issueType` → `fields.issuetype.name`, `description` → `fields.description`, `priority` → `fields.priority.name`
- **Transition issue**: `transitionId` → `transition.id`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The credential is **email + token**, not the token alone. A token on its own returns 401.
- *Transition issue* needs a `transitionId`, which is workflow-specific — read the issue's available transitions first; the id is not the status name.
- Self-hosted Jira Data Center on a private network is blocked by the egress guard.
- `issueType` takes the type NAME (`Bug`, `Task`, `Story`), not an id.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Check you pasted the full `user:secret` pair and not just the secret. |
| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing path suffix or version segment produces a 404, not a helpful error. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
