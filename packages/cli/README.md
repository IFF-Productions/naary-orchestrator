# naary

A thin command-line client for [naary](https://github.com/IFF-Productions/naary-orchestrator) — start and watch runs, manage workflows, act on approvals, and read spend.

**Zero runtime dependencies.** Node built-ins and `fetch` only; it speaks the public `/api/v1` HTTP surface and imports no server code.

## Install

```bash
npm install -g @naary/cli
naary --help
```

Or without installing: `npx @naary/cli runs list`

## Authenticate

```bash
naary auth login --api-url https://your-naary-host
```

This opens a browser login: the CLI prints a URL and a short code, you sign in normally (SSO and
MFA included) and enter the code, and the CLI receives a **12-hour access token** plus a refresh
token it rotates for you. Nothing is typed into the terminal, and no password ever reaches the CLI.

```bash
naary auth status          # apiUrl, masked token, expiry, workspace
naary auth logout          # revoke the session server-side, then forget it
naary auth login --no-browser   # print the URL, don't try to launch anything (SSH/headless)
```

**Approving a CLI login requires a workspace owner or admin.** Approval mints an API token, and
minting one is already an owner/admin capability — so a plain member's login stays pending in the
terminal until it expires, and the "only an owner or admin can approve" message appears in the
_browser_, not in the CLI. If you're a member, ask an admin for a token and use `--token` below.

Prefer a hand-made token (CI, a service account, a member account)? That still works:

```bash
naary auth login --token nry_... --api-url https://your-naary-host
```

Tokens supplied with `--token` or `NAARY_TOKEN` are used **exactly as given** — never refreshed,
never rewritten. Only a session created by `naary auth login` is renewed automatically.

> **Use the bare origin — do not add `/api`.** The client appends `/api/v1` itself, so
> `--api-url https://your-host` requests `https://your-host/api/v1/runs`. Adding the prefix
> yourself yields `/api/api/v1/...` and 404s.

> **Point it at the web origin, not the API's own port.** That `/api` segment is stripped by
> the proxy in front of the app; the API service itself serves `/v1/...`. So a URL that
> reaches the API directly (`http://localhost:3000`) 404s on every request. The default,
> `http://localhost:8081`, is the local web app from `docker compose up`.

Credentials land in `~/.naary/config.json` (written `0600`, inside a `0700` directory, and
replaced atomically so a crash mid-rotation cannot truncate the file and lose the session).

Resolution order is **flags → environment → config file → default**:

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| flags       | `--api-url`, `--token`, `--env` (pass _after_ `<group> <command>`) |
| environment | `NAARY_API_URL`, `NAARY_TOKEN`, `NAARY_ENV`                        |
| file        | `~/.naary/config.json`                                             |

Prefer `NAARY_TOKEN` in CI so the token never lands on disk.

## Commands

```bash
naary auth login [--no-browser] | login --token <nry_...> | status | logout

naary runs start [--workflow KEY] [--input '<json>'] [--env ENV]
naary runs list [--limit N] [--cursor C]
naary runs get <id>
naary runs watch <id> [--exit-code] [--interval SEC]
naary runs cancel <id>
naary runs rerun <id> [--version N]

naary workflows list
naary workflows get <key>
naary workflows export <key> [--out file.json]
naary workflows import <file.json> [--key KEY] [--name NAME]
naary workflows delete <key>
naary workflows promote <key> --to <env> [--from-version N]

naary approvals list
naary approvals approve <id> [--comment "..."]
naary approvals reject  <id> [--comment "..."]

naary config variables list | set <key> <value> | delete <key>
naary config secrets   list | set <name> <value> | delete <name>
naary config usage    [--from ISO] [--to ISO]
naary config insights [--from ISO] [--to ISO] [--environment ID] [--json]
```

`naary <group> --help` lists that group's flags. `naary --version` (top level only).

Secret **values are write-only** — `secrets list` returns names, never values, because the
server does not return them.

## Environments

`--env` / `NAARY_ENV` is sent as the `X-Environment-Id` header. A token bound to one
environment overrides it. Note `config insights --environment ID` is a _query filter_ on the
rollup, which is a different thing from the `--env` header.

## Exit codes

`0` success · `1` request or usage error.

`runs watch` exits 0 once the run reaches any terminal status. Pass `--exit-code` to make a
failed run exit non-zero instead — the form you want in CI.
