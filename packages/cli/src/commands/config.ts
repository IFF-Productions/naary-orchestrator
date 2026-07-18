/**
 * `naary config ...` commands — the v1 /config surface: Global Variables ($vars),
 * WRITE-ONLY Environment Secrets ($secrets), and the usage ledger.
 *
 * The router is two-level (`<group> <command>`), so the third word (list/set/delete)
 * arrives as the first positional and is dispatched here.
 *
 * SECURITY: secrets are write-only end to end — `secrets list` shows NAMES ONLY (the
 * server never returns values) and `secrets set` never echoes the value back.
 */

import { parseCommand, str } from "../args";
import type { CommandContext } from "../context";
import { table, usd } from "../format";
import { GROUP_HELP } from "../help";

interface UsageResponse {
  totalCostUsd?: number;
  totalTokens?: number;
  byModel?: Array<{
    provider?: string;
    model?: string;
    calls?: number;
    totalTokens?: number;
    costUsd?: number;
  }>;
}

export async function configVariables(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.config);
    return 0;
  }
  const [action, key, value] = args.positionals;
  const usage =
    "naary config variables <list | set <key> <value> | delete <key>>";
  const { client } = ctx.makeClient(args.configFlags);

  switch (action) {
    case "list": {
      const rows =
        await client.request<Array<{ key: string; value: string }>>(
          "/config/variables",
        );
      if (!rows.length) {
        ctx.io.out("No variables.");
        return 0;
      }
      ctx.io.out(
        table(
          rows.map((r) => ({ key: r.key, value: r.value })),
          [
            ["KEY", "key"],
            ["VALUE", "value"],
          ],
        ),
      );
      return 0;
    }
    case "set": {
      if (!key || value === undefined) {
        ctx.io.err(`Missing key/value. Usage: ${usage}`);
        return 1;
      }
      const v = await client.request<{ key: string; value: string }>(
        `/config/variables/${encodeURIComponent(key)}`,
        { method: "PUT", body: { value } },
      );
      ctx.io.out(`Set ${v.key}.`);
      return 0;
    }
    case "delete": {
      if (!key) {
        ctx.io.err(`Missing key. Usage: ${usage}`);
        return 1;
      }
      await client.request(`/config/variables/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      ctx.io.out(`Deleted ${key}.`);
      return 0;
    }
    default:
      ctx.io.err(
        `Unknown action${action ? ` '${action}'` : ""}. Usage: ${usage}`,
      );
      return 1;
  }
}

export async function configSecrets(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.config);
    return 0;
  }
  const [action, name, value] = args.positionals;
  const usage =
    "naary config secrets <list | set <name> <value> | delete <name>>";
  const { client } = ctx.makeClient(args.configFlags);

  switch (action) {
    case "list": {
      // WRITE-ONLY invariant: the server returns names only; values are never readable.
      const rows =
        await client.request<Array<{ name: string }>>("/config/secrets");
      if (!rows.length) {
        ctx.io.out("No secrets.");
        return 0;
      }
      ctx.io.out(
        table(
          rows.map((r) => ({ name: r.name })),
          [["NAME", "name"]],
        ),
      );
      return 0;
    }
    case "set": {
      if (!name || value === undefined) {
        ctx.io.err(`Missing name/value. Usage: ${usage}`);
        return 1;
      }
      await client.request(`/config/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: { value },
      });
      // NEVER echo the value — write-only invariant.
      ctx.io.out(`Secret ${name} set.`);
      return 0;
    }
    case "delete": {
      if (!name) {
        ctx.io.err(`Missing name. Usage: ${usage}`);
        return 1;
      }
      await client.request(`/config/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      ctx.io.out(`Deleted ${name}.`);
      return 0;
    }
    default:
      ctx.io.err(
        `Unknown action${action ? ` '${action}'` : ""}. Usage: ${usage}`,
      );
      return 1;
  }
}

export async function configUsage(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    from: { type: "string" },
    to: { type: "string" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.config);
    return 0;
  }
  const from = str(args.values.from);
  const to = str(args.values.to);
  const { client } = ctx.makeClient(args.configFlags);
  const u = await client.request<UsageResponse>("/config/usage", {
    query: { from, to },
  });
  ctx.io.out(
    `Total cost: ${usd(u.totalCostUsd ?? 0)}  Total tokens: ${u.totalTokens ?? 0}`,
  );
  const byModel = u.byModel ?? [];
  if (byModel.length) {
    ctx.io.out(
      table(
        byModel.map((m) => ({
          provider: m.provider ?? "",
          model: m.model ?? "",
          calls: m.calls ?? 0,
          tokens: m.totalTokens ?? 0,
          cost: usd(m.costUsd),
        })),
        [
          ["PROVIDER", "provider"],
          ["MODEL", "model"],
          ["CALLS", "calls"],
          ["TOKENS", "tokens"],
          ["COST", "cost"],
        ],
      ),
    );
  }
  return 0;
}

export const CONFIG_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  variables: configVariables,
  secrets: configSecrets,
  usage: configUsage,
};
