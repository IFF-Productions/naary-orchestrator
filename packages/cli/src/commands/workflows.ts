/** `naary workflows ...` commands. */

import fs from "node:fs";
import { int, parseCommand, str } from "../args";
import type { CommandContext } from "../context";
import { prettyJson, shortTime, table } from "../format";
import { GROUP_HELP } from "../help";
import { toImport, type WorkflowExport } from "../workflow-doc";

interface WorkflowListItem {
  workflowKey: string;
  name?: string;
  version?: number;
  updatedAt?: string;
  active?: boolean;
}

function requireKey(
  positionals: string[],
  ctx: CommandContext,
  usage: string,
): string | undefined {
  const key = positionals[0];
  if (!key) {
    ctx.io.err(`Missing workflow key. Usage: ${usage}`);
    return undefined;
  }
  return key;
}

export async function workflowsList(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const { client } = ctx.makeClient(args.configFlags);
  const list = await client.request<WorkflowListItem[]>("/workflows");
  if (!list.length) {
    ctx.io.out("No workflows.");
    return 0;
  }
  ctx.io.out(
    table(
      list.map((w) => ({
        key: w.workflowKey,
        name: w.name ?? "",
        version: w.version ?? "",
        active: w.active ? "yes" : "no",
        updated: shortTime(w.updatedAt),
      })),
      [
        ["KEY", "key"],
        ["NAME", "name"],
        ["VER", "version"],
        ["ACTIVE", "active"],
        ["UPDATED", "updated"],
      ],
    ),
  );
  return 0;
}

export async function workflowsGet(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const key = requireKey(args.positionals, ctx, "naary workflows get <key>");
  if (!key) return 1;
  const { client } = ctx.makeClient(args.configFlags);
  const doc = await client.request<WorkflowExport>(
    `/workflows/${encodeURIComponent(key)}`,
  );
  ctx.io.out(prettyJson(doc));
  return 0;
}

export async function workflowsExport(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, { out: { type: "string" } });
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const key = requireKey(
    args.positionals,
    ctx,
    "naary workflows export <key> [--out file.json]",
  );
  if (!key) return 1;
  const { client } = ctx.makeClient(args.configFlags);
  const doc = await client.request<WorkflowExport>(
    `/workflows/${encodeURIComponent(key)}`,
  );
  const json = prettyJson(doc);
  const out = str(args.values.out);
  if (out) {
    fs.writeFileSync(out, json + "\n");
    ctx.io.out(`Exported ${key} → ${out}`);
  } else {
    ctx.io.out(json);
  }
  return 0;
}

export async function workflowsImport(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    key: { type: "string" },
    name: { type: "string" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const file = args.positionals[0];
  if (!file) {
    ctx.io.err(
      "Missing file. Usage: naary workflows import <file.json> [--key KEY] [--name NAME]",
    );
    return 1;
  }
  let doc: Partial<WorkflowExport>;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkflowExport>;
  } catch (e) {
    ctx.io.err(`Could not read/parse ${file}: ${(e as Error).message}`);
    return 1;
  }
  let key: string;
  let body: { name: string; graph: unknown };
  try {
    ({ key, body } = toImport(doc, {
      key: str(args.values.key),
      name: str(args.values.name),
    }));
  } catch (e) {
    ctx.io.err((e as Error).message);
    return 1;
  }
  const { client } = ctx.makeClient(args.configFlags);
  const res = await client.request<{
    workflowKey: string;
    version: number;
    contentHash: string;
  }>(`/workflows/${encodeURIComponent(key)}`, { method: "PUT", body });
  ctx.io.out(
    `Imported ${res.workflowKey} → version ${res.version} (${res.contentHash}).`,
  );
  return 0;
}

export async function workflowsDelete(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const key = requireKey(args.positionals, ctx, "naary workflows delete <key>");
  if (!key) return 1;
  const { client } = ctx.makeClient(args.configFlags);
  await client.request(`/workflows/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  ctx.io.out(`Deleted ${key}.`);
  return 0;
}

export async function workflowsPromote(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    to: { type: "string" },
    "from-version": { type: "string" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.workflows);
    return 0;
  }
  const key = requireKey(
    args.positionals,
    ctx,
    "naary workflows promote <key> --to <env> [--from-version N]",
  );
  if (!key) return 1;
  const toEnv = str(args.values.to);
  if (!toEnv) {
    ctx.io.err("Missing --to <env>.");
    return 1;
  }
  const fromVersion = int(args.values["from-version"]);
  const { client } = ctx.makeClient(args.configFlags);
  const res = await client.request<{
    fromVersion: number;
    toVersion: number;
    contentHash: string;
  }>(`/workflows/${encodeURIComponent(key)}/promote`, {
    method: "POST",
    body: { toEnv, fromVersion },
  });
  ctx.io.out(
    `Promoted ${key} to ${toEnv}: v${res.fromVersion} → v${res.toVersion} (${res.contentHash}).`,
  );
  return 0;
}

export const WORKFLOWS_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  list: workflowsList,
  get: workflowsGet,
  export: workflowsExport,
  import: workflowsImport,
  delete: workflowsDelete,
  promote: workflowsPromote,
};
