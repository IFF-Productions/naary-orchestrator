import { NotFoundException } from "@nestjs/common";
import {
  type Client,
  defaultPayloadConverter,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  stateQuery,
  type ApprovalAwaitingRecord,
  type ExecutionState,
  type ExecutionStatus,
} from "@naary/contracts";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import type { EnvironmentsService } from "../environments/environments.service";
import type { GraphsService } from "../graphs/graphs.service";
import type { PermissionsService } from "../permissions/permissions.service";
import {
  awaitingFields,
  awaitingRecord,
  costUsdFrom,
  decodeRunCursor,
  dueAtFrom,
  encodeRunCursor,
  mapHistoryEvent,
  nodeTimesFrom,
} from "./executions.helpers";
import {
  type AwaitingApproval,
  type RawHistoryEvent,
  type RunEvent,
  type RunPage,
  type RunStateView,
  type RunSummary,
  TEMPORAL_CLOSED_STATUS,
} from "./executions.types";

/**
 * The class members the extracted read/approval method bodies reach through `this`,
 * passed in as a single object of bound callbacks (arrow wrappers capturing `this`)
 * + the always-present collaborators. `perms` is a LAZY thunk (not a resolved value)
 * so the fail-closed throw fires at the SAME point the original `this.perms()` did —
 * never eagerly at deps-build time (which would break the permission-less test
 * constructions before their actor guard runs).
 */
export interface ExecutionsDeps {
  client: Client;
  environments: EnvironmentsService;
  graphs: GraphsService;
  perms: () => PermissionsService;
  assertOwner: (
    workflowId: string,
    tenantId: string,
  ) => Promise<{
    tenantId: string;
    workflowKey: string | null;
    environmentId: string | null;
  }>;
  assertRunAccess: (
    actor: Principal | undefined,
    action: "view" | "run",
    row: {
      tenantId: string;
      workflowKey: string | null;
      environmentId: string | null;
    },
  ) => Promise<void>;
  assertApprover: (
    actor: Principal | undefined,
    workflowId: string,
    tenantId: string,
  ) => Promise<void>;
  runViewFilter: (
    actor: Principal | undefined,
    tenantId: string,
  ) => Promise<Record<string, unknown> | null>;
  toRunSummary: (r: {
    workflowId: string;
    workflowKey: string | null;
    status: string;
    costUsd: unknown;
    createdAt: Date;
    finishedAt: Date | null;
    failureKind: string | null;
    archivedAt: Date | null;
    graphVersion: number | null;
  }) => Promise<RunSummary>;
  approvalPrompt: (
    tenantId: string,
    environmentId: string | null,
    workflowKey: string | null,
    nodeId: string,
  ) => Promise<{ title: string; instructions: string | null }>;
  approve: (
    id: string,
    approved: boolean,
    tenantId: string,
    comment?: string,
    actor?: Principal,
  ) => Promise<void>;
}

export async function queryListPage(
  deps: ExecutionsDeps,
  tenantId: string,
  opts: { limit?: number; cursor?: string; archived?: boolean } = {},
  actor?: Principal,
): Promise<RunPage> {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  // Default view hides archived runs; `archived: true` shows only the archived ones.
  const base = { tenantId, archivedAt: opts.archived ? { not: null } : null };
  // Keyset filter: rows strictly AFTER the cursor row in the (DESC, DESC) order.
  const keyset = opts.cursor
    ? {
        ...base,
        OR: (({ createdAt, workflowId }) => [
          { createdAt: { lt: createdAt } },
          { createdAt, workflowId: { lt: workflowId } },
        ])(decodeRunCursor(opts.cursor)),
      }
    : base;
  // View scoping composes via AND so it can't collide with the keyset's own OR. Null
  // for unrestricted callers — their query is byte-identical to before G3.
  const viewFilter = await deps.runViewFilter(actor, tenantId);
  const where = viewFilter ? { ...keyset, AND: [viewFilter] } : keyset;
  const rows = await getPrisma().execution.findMany({
    where,
    // The workflowId tiebreak makes the order TOTAL, so a page boundary can't
    // skip/duplicate rows that share a createdAt.
    orderBy: [{ createdAt: "desc" }, { workflowId: "desc" }],
    take: take + 1, // one extra row probes "is there a next page?"
  });
  const page = rows.slice(0, take);
  const nextCursor =
    rows.length > take ? encodeRunCursor(page[page.length - 1]) : null;
  const items = await Promise.all(page.map((r) => deps.toRunSummary(r)));
  return { items, nextCursor };
}

export async function queryState(
  deps: ExecutionsDeps,
  id: string,
  tenantId: string,
  actor?: Principal,
): Promise<RunStateView> {
  const row = await deps.assertOwner(id, tenantId);
  // G3 (§8.4): the run detail (incl. its ctx/output) is view-gated on its workflow.
  await deps.assertRunAccess(actor, "view", row);
  const handle = deps.client.workflow.getHandle(id);
  try {
    const desc = await handle.describe();
    if (desc.status.name === "RUNNING") {
      // Wrap the query (mirrors list()): a transient replay/worker hiccup must
      // degrade to "running", never 500.
      try {
        const s = await handle.query(stateQuery);
        return {
          status: s.status,
          currentNodeId: s.currentNodeId,
          ctx: s.ctx,
          nodeTimes: nodeTimesFrom(s.ctx),
          // Slice 3 live spend: the query's first-class figure; a pre-feature worker
          // omits it → fall back to the ctx mirror; null when neither exists.
          spentUsd: s.spentUsd ?? costUsdFrom(s.ctx),
          perExecutionCapUsd: s.perExecutionCapUsd ?? null,
        };
      } catch {
        return {
          status: "running",
          currentNodeId: "",
          ctx: {},
          nodeTimes: null,
          spentUsd: null,
          perExecutionCapUsd: null,
        };
      }
    }
    if (desc.status.name === "COMPLETED") {
      try {
        const r = (await handle.result()) as {
          status: ExecutionStatus;
          ctx: Record<string, unknown>;
        };
        return {
          status: r.status,
          currentNodeId: "",
          ctx: r.ctx,
          nodeTimes: nodeTimesFrom(r.ctx),
          spentUsd: costUsdFrom(r.ctx),
          perExecutionCapUsd: null, // closed — no live cap to meter against
        };
      } catch {
        return {
          status: "completed",
          currentNodeId: "",
          ctx: {},
          nodeTimes: null,
          spentUsd: null,
          perExecutionCapUsd: null,
        };
      }
    }
    // Temporal-level failure (the workflow threw, was terminated, etc.) — there's
    // no returned {status,ctx} to recover, so report the mapped close reason.
    return {
      status: TEMPORAL_CLOSED_STATUS[desc.status.name] ?? "unknown",
      currentNodeId: "",
      ctx: {},
      nodeTimes: null,
      spentUsd: null,
      perExecutionCapUsd: null,
    };
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new NotFoundException("Execution not found");
    }
    throw e;
  }
}

export async function queryAwaiting(
  deps: ExecutionsDeps,
  tenantId: string,
  actor?: Principal,
): Promise<AwaitingApproval[]> {
  let rows = await getPrisma().execution.findMany({
    where: { tenantId, status: "awaiting_approval" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // G3 (§8.4): a RESTRICTED subject's inbox is view-filtered to its workflows —
  // BEFORE the per-run Temporal queries, so invisible runs cost nothing. Key-less
  // legacy rows are visible only to unrestricted subjects (same rule as the list).
  if (actor) {
    const perms = deps.perms();
    const eff = await perms.getEffective(actor);
    if (eff.restricted) {
      const visible = await Promise.all(
        rows.map(async (r) => {
          if (r.workflowKey === null) return false;
          const envId =
            r.environmentId ?? (await deps.environments.defaultEnvId(tenantId));
          return perms.can(actor, "view", r.workflowKey, envId);
        }),
      );
      rows = rows.filter((_, i) => visible[i]);
    }
  }
  const items = await Promise.all(
    rows.map(async (r): Promise<AwaitingApproval | null> => {
      let currentNodeId = "";
      let rec: ApprovalAwaitingRecord | null = null;
      try {
        const s = await deps.client.workflow
          .getHandle(r.workflowId)
          .query(stateQuery);
        // Decided/advanced since the read-model write, or closed → not awaiting.
        if (s.status !== "awaiting_approval") return null;
        currentNodeId = s.currentNodeId;
        // Slice 1: the pause-time snapshot (contextFields/SLA/approvers) rides the ctx.
        rec = awaitingRecord(s);
      } catch {
        return null; // closed/gone
      }
      const prompt = await deps.approvalPrompt(
        tenantId,
        r.environmentId,
        r.workflowKey,
        currentNodeId,
      );
      return {
        workflowId: r.workflowId,
        workflowKey: r.workflowKey,
        nodeId: currentNodeId,
        title: prompt.title,
        instructions: prompt.instructions,
        createdAt: r.createdAt.toISOString(),
        ...awaitingFields(rec),
      };
    }),
  );
  return items.filter((x): x is AwaitingApproval => x !== null);
}

export async function queryPromptByWorkflowId(
  deps: ExecutionsDeps,
  workflowId: string,
): Promise<{
  awaiting: boolean;
  title?: string;
  instructions?: string | null;
  workspaceName?: string | null;
  contextFields?: Record<string, string> | null;
  slaHours?: number | null;
  dueAt?: string | null;
}> {
  const row = await getPrisma().execution.findUnique({
    where: { workflowId },
  });
  if (!row) return { awaiting: false };
  try {
    const s = await deps.client.workflow
      .getHandle(workflowId)
      .query(stateQuery);
    if (s.status !== "awaiting_approval") return { awaiting: false };
    const prompt = await deps.approvalPrompt(
      row.tenantId,
      row.environmentId,
      row.workflowKey,
      s.currentNodeId,
    );
    const rec = awaitingRecord(s);
    // Best-effort workspace display name — the public trust line ("on behalf of Acme").
    const settings = await getPrisma()
      .tenantSettings.findUnique({
        where: { tenantId: row.tenantId },
        select: { displayName: true },
      })
      .catch(() => null);
    return {
      awaiting: true,
      title: prompt.title,
      instructions: prompt.instructions,
      workspaceName: settings?.displayName ?? null,
      contextFields: rec?.contextFields ?? null,
      slaHours: rec?.slaHours ?? null,
      dueAt: dueAtFrom(rec),
    };
  } catch {
    return { awaiting: false };
  }
}

export async function queryHistory(
  deps: ExecutionsDeps,
  id: string,
  tenantId: string,
  actor?: Principal,
): Promise<RunEvent[]> {
  const row = await deps.assertOwner(id, tenantId);
  await deps.assertRunAccess(actor, "view", row);
  let h: { events?: unknown[] | null };
  try {
    h = await deps.client.workflow.getHandle(id).fetchHistory();
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new NotFoundException("Execution not found");
    }
    throw e;
  }
  const out: RunEvent[] = [];
  for (const raw of h.events ?? []) {
    const ev = mapHistoryEvent(raw as RawHistoryEvent);
    if (ev) out.push(ev);
  }
  return out;
}

export async function queryOriginalTriggerInput(
  deps: ExecutionsDeps,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  let h: { events?: unknown[] | null };
  try {
    h = await deps.client.workflow.getHandle(id).fetchHistory();
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new NotFoundException("Execution not found");
    }
    throw e;
  }
  const started = (h.events ?? []).find(
    (ev) =>
      (ev as { workflowExecutionStartedEventAttributes?: unknown })
        .workflowExecutionStartedEventAttributes,
  ) as
    | {
        workflowExecutionStartedEventAttributes?: {
          input?: { payloads?: unknown[] };
        };
      }
    | undefined;
  const payloads =
    started?.workflowExecutionStartedEventAttributes?.input?.payloads;
  if (!payloads || payloads.length < 2) return undefined;
  try {
    const decoded = defaultPayloadConverter.fromPayload(payloads[1] as never);
    return decoded == null ? undefined : (decoded as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

export async function queryRunGraph(
  deps: ExecutionsDeps,
  id: string,
  tenantId: string,
  actor?: Principal,
): Promise<{
  graph: Record<string, unknown>;
  version: number | null;
  workflowKey: string | null;
}> {
  const owned = await deps.assertOwner(id, tenantId);
  await deps.assertRunAccess(actor, "view", owned);
  let h: { events?: unknown[] | null };
  try {
    h = await deps.client.workflow.getHandle(id).fetchHistory();
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new NotFoundException("Execution not found");
    }
    throw e;
  }
  const started = (h.events ?? []).find(
    (ev) =>
      (ev as { workflowExecutionStartedEventAttributes?: unknown })
        .workflowExecutionStartedEventAttributes,
  ) as
    | {
        workflowExecutionStartedEventAttributes?: {
          input?: { payloads?: unknown[] };
        };
      }
    | undefined;
  const payloads =
    started?.workflowExecutionStartedEventAttributes?.input?.payloads;
  if (!payloads || payloads.length < 1) {
    throw new NotFoundException("This run has no stored graph snapshot.");
  }
  let graph: unknown;
  try {
    // fromPayload can throw on a malformed/unknown payload — treat that as "no usable
    // snapshot" (404), not an unhandled 500 (mirrors originalTriggerInput's guard).
    graph = defaultPayloadConverter.fromPayload(payloads[0] as never);
  } catch {
    graph = undefined;
  }
  // Require a GraphDef-SHAPED object (nodes[] + edges[] + startNodeId), not just any object
  // — an array or arbitrary payload would decode fine here but then throw in the web
  // decompiler, which iterates graph.nodes AND graph.edges.
  const g = graph as {
    nodes?: unknown;
    edges?: unknown;
    startNodeId?: unknown;
  } | null;
  if (
    g == null ||
    typeof g !== "object" ||
    Array.isArray(g) ||
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    typeof g.startNodeId !== "string"
  ) {
    throw new NotFoundException("This run's graph snapshot is unavailable.");
  }
  // Version + workflowKey come from the Execution read-model row (the same source the
  // Runs list uses, so the detail label matches the list) — not re-decoded from history.
  // These let the detail view label the executed graph and drive the re-run-at-version
  // picker. version is null for pre-migration runs; workflowKey null for very old rows.
  const row = await getPrisma().execution.findUnique({
    where: { workflowId: id },
    select: { graphVersion: true, workflowKey: true },
  });
  return {
    graph: g as Record<string, unknown>,
    version: row?.graphVersion ?? null,
    workflowKey: row?.workflowKey ?? null,
  };
}
