import { getPrisma } from "./index";

/**
 * Resolve a possibly-RETIRED workflow key to the key that is live today (#904).
 *
 * A rename rewrites every row we own to the new key, so the ONLY keys that can still be stale are
 * ones supplied from outside the database: another graph's `executeSubWorkflow`/`forEach` node
 * config, an MCP tool name or `run_workflow` argument in an external agent's config, the args of an
 * in-flight Temporal run or an already-armed schedule handle, a public-API / `naary` CLI caller, or
 * a bookmarked canvas URL. Every one of those enters through a lookup that funnels here.
 *
 * Lives in `@naary/db` rather than the API so the WORKER can import the same implementation — the
 * sub-workflow resolver runs in a different process and is the single most important consumer.
 * NEVER call from workflow code (Prisma is non-deterministic; this is activity/API-only).
 *
 * Cheap and honest: one indexed PK lookup, and it returns the input unchanged when there is no
 * alias — which is the case for every key in a workspace that has never renamed anything.
 */
export async function resolveWorkflowKey(
  tenantId: string,
  workflowKey: string,
): Promise<string> {
  const row = await getPrisma().workflowKeyAlias.findUnique({
    where: { tenantId_alias: { tenantId, alias: workflowKey } },
    select: { workflowKey: true },
  });
  // Aliases are stored ONE HOP deep (a second rename re-points the existing rows), so a single
  // lookup is always enough — there is no chain to walk and therefore no cycle to guard against.
  return row?.workflowKey ?? workflowKey;
}

/**
 * The retired keys that resolve to `workflowKey`. Used by the rename to re-point them (keeping
 * aliases one hop deep) and by the workflow delete to free them for reuse.
 */
export async function aliasesOf(
  tenantId: string,
  workflowKey: string,
): Promise<string[]> {
  const rows = await getPrisma().workflowKeyAlias.findMany({
    where: { tenantId, workflowKey },
    select: { alias: true },
  });
  return rows.map((r) => r.alias);
}
