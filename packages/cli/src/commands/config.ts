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

import { bool, parseCommand, str } from "../args";
import type { CommandContext } from "../context";
import { prettyJson, table, usd } from "../format";
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

interface Bucket {
  costUsd: number;
  totalTokens: number;
  calls: number;
}
interface Insights {
  range: { from: string | null; to: string | null };
  totals: Bucket;
  byDay: (Bucket & { date: string })[];
  byEnvironment: (Bucket & { environmentId: string | null })[];
  byWorkflow: (Bucket & { workflowKey: string | null })[];
  byModel: (Bucket & { provider: string; model: string })[];
}

const num = (n: number): string => n.toLocaleString();

const bucketTable = (
  title: string,
  label: string,
  rows: Array<{ name: string } & Bucket>,
  ctx: CommandContext,
): void => {
  ctx.io.out(`${title}:`);
  ctx.io.out(
    table(
      rows.map((r) => ({
        name: r.name,
        cost: usd(r.costUsd),
        tokens: num(r.totalTokens),
        calls: num(r.calls),
      })),
      [
        [label, "name"],
        ["COST", "cost"],
        ["TOKENS", "tokens"],
        ["CALLS", "calls"],
      ],
    ),
  );
  ctx.io.out("");
};

/**
 * `naary config insights` — spend rolled up by environment, workflow, and model over an optional
 * window. NOTE: `--environment` filters via the endpoint's `?environmentId` query — distinct from the
 * global `--env` (X-Environment-Id header), which this cross-environment rollup intentionally ignores.
 */
export async function configInsights(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, {
    from: { type: "string" },
    to: { type: "string" },
    environment: { type: "string" },
    json: { type: "boolean" },
  });
  if (args.help) {
    ctx.io.out(GROUP_HELP.config);
    return 0;
  }
  const { client } = ctx.makeClient(args.configFlags);
  const data = await client.request<Insights>("/config/insights", {
    query: {
      from: str(args.values.from),
      to: str(args.values.to),
      environmentId: str(args.values.environment),
    },
  });

  if (bool(args.values.json)) {
    ctx.io.out(prettyJson(data));
    return 0;
  }

  const window =
    data.range.from || data.range.to
      ? `${data.range.from ?? "…"} → ${data.range.to ?? "now"}`
      : "all time";
  ctx.io.out(
    `Total: ${usd(data.totals.costUsd)} · ${num(data.totals.totalTokens)} tokens · ${num(
      data.totals.calls,
    )} calls (${window})`,
  );
  ctx.io.out("");
  bucketTable(
    "By environment",
    "ENVIRONMENT",
    data.byEnvironment.map((e) => ({
      name: e.environmentId ?? "(untagged)",
      ...e,
    })),
    ctx,
  );
  bucketTable(
    "By workflow",
    "WORKFLOW",
    data.byWorkflow.map((w) => ({ name: w.workflowKey ?? "(no key)", ...w })),
    ctx,
  );
  bucketTable(
    "By model",
    "MODEL",
    data.byModel.map((m) => ({ name: `${m.provider}/${m.model}`, ...m })),
    ctx,
  );
  ctx.io.out(
    `${data.byDay.length} day${data.byDay.length === 1 ? "" : "s"} with activity — use --json for the daily series.`,
  );
  return 0;
}

export const CONFIG_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  variables: configVariables,
  secrets: configSecrets,
  usage: configUsage,
  insights: configInsights,
};
