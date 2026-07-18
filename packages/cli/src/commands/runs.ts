/** `naary runs ...` commands. */

import { bool, int, parseCommand, str } from "../args";
import type { CommandContext } from "../context";
import { prettyJson, shortTime, table, usd } from "../format";
import { GROUP_HELP } from "../help";
import { exitCodeFor, watchRun, type RunSnapshot } from "../watch";

interface RunListItem {
  runId: string;
  workflowKey?: string;
  status: string;
  costUsd?: number;
  startedAt?: string;
  graphVersion?: number;
}

function requireId(
  positionals: string[],
  ctx: CommandContext,
  usage: string,
): string | undefined {
  const id = positionals[0];
  if (!id) {
    ctx.io.err(`Missing run id. Usage: ${usage}`);
    return undefined;
  }
  return id;
}

export async function runsStart(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    workflow: { type: "string" },
    input: { type: "string" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const workflowKey = str(args.values.workflow);
  const inputRaw = str(args.values.input);
  let input: unknown;
  if (inputRaw !== undefined) {
    try {
      input = JSON.parse(inputRaw);
    } catch {
      ctx.io.err(`--input is not valid JSON: ${inputRaw}`);
      return 1;
    }
  }
  const { client } = ctx.makeClient(args.configFlags);
  const res = await client.request<{ runId: string }>("/runs", {
    method: "POST",
    body: { workflowKey, input },
  });
  ctx.io.out(res.runId);
  return 0;
}

export async function runsList(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, { limit: { type: "string" } });
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const limit = int(args.values.limit);
  const { client } = ctx.makeClient(args.configFlags);
  const runs = await client.request<RunListItem[]>("/runs", {
    query: { limit },
  });
  if (!runs.length) {
    ctx.io.out("No runs.");
    return 0;
  }
  ctx.io.out(
    table(
      runs.map((r) => ({
        runId: r.runId,
        workflow: r.workflowKey ?? "",
        status: r.status,
        cost: usd(r.costUsd),
        version: r.graphVersion ?? "",
        started: shortTime(r.startedAt),
      })),
      [
        ["RUN ID", "runId"],
        ["WORKFLOW", "workflow"],
        ["STATUS", "status"],
        ["COST", "cost"],
        ["VER", "version"],
        ["STARTED", "started"],
      ],
    ),
  );
  return 0;
}

export async function runsGet(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const id = requireId(args.positionals, ctx, "naary runs get <id>");
  if (!id) return 1;
  const { client } = ctx.makeClient(args.configFlags);
  const run = await client.request<RunSnapshot>(
    `/runs/${encodeURIComponent(id)}`,
  );
  ctx.io.out(prettyJson(run));
  return 0;
}

export async function runsWatch(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    "exit-code": { type: "boolean" },
    interval: { type: "string" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const id = requireId(
    args.positionals,
    ctx,
    "naary runs watch <id> [--exit-code] [--interval SEC]",
  );
  if (!id) return 1;
  const intervalSec = int(args.values.interval);
  const intervalMs = (intervalSec && intervalSec > 0 ? intervalSec : 3) * 1000;
  const exitCode = bool(args.values["exit-code"]);

  const { client } = ctx.makeClient(args.configFlags);
  const final = await watchRun(id, {
    intervalMs,
    getRun: (rid) =>
      client.request<RunSnapshot>(`/runs/${encodeURIComponent(rid)}`),
    onTransition: (status) => ctx.io.out(`${id}  ${status}`),
  });

  if (exitCode) return exitCodeFor(final.status);
  return 0;
}

export async function runsCancel(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const id = requireId(args.positionals, ctx, "naary runs cancel <id>");
  if (!id) return 1;
  const { client } = ctx.makeClient(args.configFlags);
  await client.request(`/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  ctx.io.out(`Cancellation requested for ${id}.`);
  return 0;
}

export async function runsRerun(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, { version: { type: "string" } });
  if (args.help) {
    ctx.io.out(GROUP_HELP.runs);
    return 0;
  }
  const id = requireId(
    args.positionals,
    ctx,
    "naary runs rerun <id> [--version N]",
  );
  if (!id) return 1;
  const graphVersion = int(args.values.version);
  const { client } = ctx.makeClient(args.configFlags);
  const res = await client.request<{ runId: string }>(
    `/runs/${encodeURIComponent(id)}/rerun`,
    { method: "POST", body: { graphVersion } },
  );
  ctx.io.out(res.runId);
  return 0;
}

export const RUNS_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  start: runsStart,
  list: runsList,
  get: runsGet,
  watch: runsWatch,
  cancel: runsCancel,
  rerun: runsRerun,
};
