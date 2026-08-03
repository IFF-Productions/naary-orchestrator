# naary

A thin command-line client for [naary](https://github.com/IFF-Productions/naary-orchestrator) — list and watch runs, inspect workflows, and act on approvals from a terminal.

**Zero runtime dependencies.** Node built-ins and `fetch` only; it speaks the public `/api/v1` HTTP surface and imports no server code.

## Install

```bash
npm install -g @naary/cli
naary --help
```

Or without installing:

```bash
npx @naary/cli runs list
```

## Authenticate

Create an API token in **Settings → API tokens**, then:

```bash
naary config set token nry_...
naary config set api-url https://your-host/api
```

> Note the `/api` prefix — the SPA's proxy strips it before forwarding, so the public URL carries it.

Configuration resolves **flags → environment → config file → default**:

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| flags       | `--token`, `--api-url`, `--env`                                |
| environment | `NAARY_TOKEN`, `NAARY_API_URL`, `NAARY_ENV`                    |
| file        | `~/.naary/config.json` (written `0600`, in a `0700` directory) |

Prefer `NAARY_TOKEN` in CI so the token never lands on disk.

## Commands

```bash
naary runs list [--status failed] [--limit 20]
naary runs get <runId>
naary runs watch <runId>          # poll until the run reaches a terminal status
naary workflows list
naary workflows get <key>
naary approvals list
naary approvals approve <runId> [--note "..."]
naary approvals reject  <runId> [--note "..."]
naary config get|set|path
```

`naary <command> --help` prints the flags for that command. `--json` prints machine-readable output.

## Exit codes

`0` success · `1` request or usage error · `2` the watched run finished in a failed state.

## Environments

A token may be bound to one environment, in which case that binding wins. Otherwise `--env` / `NAARY_ENV` selects it, and omitting both uses the workspace default.
