# GitHub integration

Act on GitHub issues — read, create, comment, and label — from a workflow.

## Setup

1. **Create a token.** In GitHub → *Settings → Developer settings → Personal access tokens*,
   create a token (classic, with the **`repo`** scope, or a fine-grained token with **Issues:
   Read and write** on the target repos). A GitHub App installation token also works.
2. **Add the connection.** In **Integrations → Connect a server**:
   - **Type:** GitHub
   - **Server URL:** `https://api.github.com`
   - **Auth:** paste the token (stored as the connection's Bearer token).
3. **Add the GitHub node** to your canvas, pick this connection, choose an action, and fill the
   fields (bind the dynamic ones — e.g. issue number — to an upstream step).

> Cloud only: `api.github.com`. GitHub Enterprise Server on a private network is not reachable
> (egress guard). Requests send `Accept: application/vnd.github+json` and the pinned API version.

## Actions

| Action | Method | Endpoint | Fields (\* required) |
| --- | --- | --- | --- |
| **Get issue** | GET | `/repos/{owner}/{repo}/issues/{issueNumber}` | owner\*, repo\*, issueNumber\* |
| **Create issue** (write) | POST | `/repos/{owner}/{repo}/issues` | owner\*, repo\*, title\*, body, labels |
| **Comment on issue** (write) | POST | `/repos/{owner}/{repo}/issues/{issueNumber}/comments` | owner\*, repo\*, issueNumber\*, body\* |
| **Add labels** (write) | POST | `/repos/{owner}/{repo}/issues/{issueNumber}/labels` | owner\*, repo\*, issueNumber\*, labels\* |

- `issueNumber` is a number; `labels` is a string array — these are usually **bound** from an
  upstream step (a trigger's `issue.number`, an agent's label list) rather than typed statically.
- Write actions run **at-most-once** (no auto-retry) so a lost response can't double-post.

## Output

`{ status, ok, body }` — `status` is the HTTP code (e.g. 201 on create), `body` is GitHub's JSON
response (e.g. the created issue). Branch on `<nodeId>.status`.

## Verify it works (live smoke test)

1. Point the connection's token at a throwaway repo you own.
2. Add a **GitHub → Create issue** node, set `owner`/`repo`, a static `title`, run the workflow.
3. Confirm the issue appears in the repo and the node output shows `status: 201` with the issue
   `number` in `body`. Then wire **Comment on issue** binding `issueNumber` to
   `<create-node>.body.number`.
