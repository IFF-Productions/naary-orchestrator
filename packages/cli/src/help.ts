/** Help text for the naary CLI. Plain strings so `--help` needs no dependencies. */

export const TOP_HELP = `naary — CLI for the naary orchestrator public API (/api/v1)

Usage:
  naary <group> <command> [options]

Groups:
  auth        Configure credentials (login, status)
  runs        Start, list, inspect, watch, cancel, rerun runs
  workflows   List, get, export, import, delete, promote workflows
  approvals   List and act on human-approval waits

Global options (any command):
  --api-url <url>   API base URL (default http://localhost:3000)
  --token <nry_..>  Bearer token
  --env <id>        Environment id (sent as X-Environment-Id)
  -h, --help        Show help
  -v, --version     Show version

Config precedence: flags > env (NAARY_API_URL/NAARY_TOKEN/NAARY_ENV) > ~/.naary/config.json > defaults

Run \`naary <group> --help\` for group commands.`;

export const GROUP_HELP: Record<string, string> = {
  auth: `naary auth — manage credentials

  naary auth login --token <nry_...> [--api-url <url>]   Save credentials to ~/.naary/config.json
  naary auth status                                      Show resolved apiUrl + masked token`,

  runs: `naary runs — manage runs

  naary runs start [--workflow KEY] [--input '<json>'] [--env ENV]   Start a run, print runId
  naary runs list [--limit N]                                       List recent runs
  naary runs get <id>                                               Show status + current node + output
  naary runs watch <id> [--exit-code] [--interval SEC]              Poll until terminal
  naary runs cancel <id>                                            Request cancellation
  naary runs rerun <id> [--version N]                               Re-run (optional graph version)`,

  workflows: `naary workflows — manage workflows

  naary workflows list                                    List workflows
  naary workflows get <key>                               Show a workflow (incl. graph)
  naary workflows export <key> [--out file.json]          Write the export doc (stdout if no --out)
  naary workflows import <file.json> [--key KEY] [--name NAME]   PUT the workflow
  naary workflows delete <key>                            Delete a workflow
  naary workflows promote <key> --to <env> [--from-version N]   Promote to another environment`,

  approvals: `naary approvals — human-approval waits

  naary approvals list                          List runs awaiting approval
  naary approvals approve <id> [--comment ...]  Approve
  naary approvals reject <id> [--comment ...]   Reject`,
};
