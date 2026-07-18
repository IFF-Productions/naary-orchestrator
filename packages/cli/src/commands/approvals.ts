/** `naary approvals ...` commands. */

import { parseCommand, str } from "../args";
import type { CommandContext } from "../context";
import { shortTime, table } from "../format";
import { GROUP_HELP } from "../help";

interface AwaitingItem {
  runId: string;
  workflowKey?: string;
  nodeId?: string;
  title?: string;
  instructions?: string;
  createdAt?: string;
}

export async function approvalsList(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.approvals);
    return 0;
  }
  const { client } = ctx.makeClient(args.configFlags);
  const list = await client.request<AwaitingItem[]>("/runs/awaiting");
  if (!list.length) {
    ctx.io.out("No runs awaiting approval.");
    return 0;
  }
  ctx.io.out(
    table(
      list.map((a) => ({
        runId: a.runId,
        workflow: a.workflowKey ?? "",
        node: a.nodeId ?? "",
        title: a.title ?? "",
        created: shortTime(a.createdAt),
      })),
      [
        ["RUN ID", "runId"],
        ["WORKFLOW", "workflow"],
        ["NODE", "node"],
        ["TITLE", "title"],
        ["CREATED", "created"],
      ],
    ),
  );
  return 0;
}

async function decide(
  argv: string[],
  ctx: CommandContext,
  approved: boolean,
  verb: string,
): Promise<number> {
  const args = parseCommand(argv, { comment: { type: "string" } });
  if (args.help) {
    ctx.io.out(GROUP_HELP.approvals);
    return 0;
  }
  const id = args.positionals[0];
  if (!id) {
    ctx.io.err(
      `Missing run id. Usage: naary approvals ${verb} <id> [--comment ...]`,
    );
    return 1;
  }
  const comment = str(args.values.comment);
  const { client } = ctx.makeClient(args.configFlags);
  await client.request(`/runs/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: { approved, comment },
  });
  ctx.io.out(`${approved ? "Approved" : "Rejected"} ${id}.`);
  return 0;
}

export async function approvalsApprove(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  return decide(argv, ctx, true, "approve");
}

export async function approvalsReject(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  return decide(argv, ctx, false, "reject");
}

export const APPROVALS_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  list: approvalsList,
  approve: approvalsApprove,
  reject: approvalsReject,
};
