---
title: 'Read, create, comment on and label GitHub issues and pull requests from a workflow.'
provider: github
label: 'GitHub'
category: 'Development'
authType: bearer
serverUrlRequired: false
actionCount: 5
writeActionCount: 3
oneClickTestable: false
liveVerified: true
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# GitHub

Read, create, comment on and label GitHub issues and pull requests from a workflow.

## Before you start

- **You need:** a personal access token, or a GitHub App installation token.
- **Scopes / permissions:** classic: `repo` · fine-grained: *Issues: Read and write* (add *Pull requests: Read* for the PR action)
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://api.github.com`.

## Get your credentials

1. In GitHub, open **Settings → Developer settings → Personal access tokens** and create a token — classic with `repo`, or fine-grained with **Issues: Read and write** on the target repos.
2. A **GitHub App** installation token also works, and is the better choice for an organisation: it is scoped per-repo and rotates automatically. Naary can install a GitHub App for you from the Integrations screen.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **GitHub** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** its read actions all need an id you have to supply, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **GitHub** node, pick this connection, choose a read action and fill its ids, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

A concrete first run:

1. Point the connection's token at a throwaway repo you own.
2. Add a **Create issue** node, set `owner`/`repo` and a static `title`, and run it.
3. Confirm the issue appears and the output shows `status: 201` with the new `number` in `body`.
4. Then chain **Comment on issue**, binding its `issueNumber` to `<create-node>.body.number` — that is the pattern for every provider: create, then bind the returned id.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Get issue | `GET` | `/repos/{owner}/{repo}/issues/{issueNumber}` | `owner`, `repo`, `issueNumber` | — |
| Get pull request (as diff) | `GET` | `/repos/{owner}/{repo}/pulls/{pullNumber}` | `owner`, `repo`, `pullNumber` | — |
| **Create issue** (write) | `POST` | `/repos/{owner}/{repo}/issues` | `owner`, `repo`, `title` | `body`, `labels` |
| **Comment on issue** (write) | `POST` | `/repos/{owner}/{repo}/issues/{issueNumber}/comments` | `owner`, `repo`, `issueNumber`, `body` | — |
| **Add labels** (write) | `POST` | `/repos/{owner}/{repo}/issues/{issueNumber}/labels` | `owner`, `repo`, `issueNumber`, `labels` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- **Cloud only.** `api.github.com` works; GitHub Enterprise Server on a private network is blocked by the egress guard.
- A fine-grained token must have the specific repository added to it — the scope alone is not enough.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
