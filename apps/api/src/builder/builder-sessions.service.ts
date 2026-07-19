import { Injectable, NotFoundException } from "@nestjs/common";
import { getPrisma, Prisma } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import { GraphsService } from "../graphs/graphs.service";
import type {
  BuilderSessionResponse,
  BuilderSessionSummaryResponse,
  BuilderTurnResponse,
} from "./builder-session.response";

interface TurnRow {
  id: string;
  role: string;
  content: string;
  costUsd: { toNumber(): number } | null;
  createdAt: Date;
}

interface SessionRow {
  id: string;
  status: string;
  closedReason: string | null;
  workflowKey: string | null;
  environmentId: string | null;
  title: string | null;
  currentGraph: unknown;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  turns?: TurnRow[];
}

function toTurn(row: TurnRow): BuilderTurnResponse {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    // Prisma Decimal → number; JS number is fine for a per-turn USD cost we only display.
    costUsd: row.costUsd == null ? null : row.costUsd.toNumber(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toSession(row: SessionRow): BuilderSessionResponse {
  return {
    id: row.id,
    status: row.status,
    closedReason: row.closedReason,
    workflowKey: row.workflowKey,
    environmentId: row.environmentId,
    title: row.title,
    currentGraph: row.currentGraph ?? null,
    turns: (row.turns ?? []).map(toTurn),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

/**
 * Conversational AI builder — session lifecycle (Slice 1). A session is a persisted, resumable
 * thread in which the user iteratively edits a workflow via chat; it lives in the CONTROL PLANE
 * (workers stay stateless). Slice 2 adds the streaming edit-turn endpoint that appends turns and
 * rewrites `currentGraph`. Every read/write is tenant-scoped — a session is never addressable
 * across workspaces.
 */
@Injectable()
export class BuilderSessionsService {
  constructor(private readonly graphs: GraphsService) {}

  /** Open a session, optionally seeding the working draft from an existing workflow's latest graph. */
  async open(
    tenantId: string,
    environmentId: string,
    input: { workflowKey?: string; title?: string },
  ): Promise<BuilderSessionResponse> {
    const workflowKey = input.workflowKey?.trim() || null;

    // Seed the draft from the named workflow's latest graph in this environment, if it exists.
    // NOTE (per-workflow RBAC): getLatest is the system-context accessor — it does NOT apply
    // the actor view-grant check that single-graph GET does. In a grant-enforcing workspace
    // (RBAC-GROUPS "first-grant cliff") a member who can't view workflow X could seed a draft
    // from it here. Accepted for Slice 1 (tenant-scoped per the design doc); when this feature
    // reaches grant-enforcing workspaces, pass the Principal and reuse the single-graph
    // view-check before seeding. Tracked in the PR description.
    let currentGraph: unknown = null;
    if (workflowKey) {
      const snapshot = await this.graphs.getLatest(
        tenantId,
        environmentId,
        workflowKey,
      );
      currentGraph = snapshot?.graph ?? null;
    }

    const row = await getPrisma().builderSession.create({
      data: {
        tenantId,
        environmentId,
        workflowKey,
        title: input.title?.trim() || null,
        currentGraph: (currentGraph ?? undefined) as object | undefined,
      },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    return toSession(row as unknown as SessionRow);
  }

  /** Fetch a session (with its turns) — tenant-scoped; 404 if it isn't this workspace's. */
  async get(tenantId: string, id: string): Promise<BuilderSessionResponse> {
    const row = await getPrisma().builderSession.findFirst({
      where: { id, tenantId },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    if (!row) {
      throw new NotFoundException("Builder session not found.");
    }
    return toSession(row as unknown as SessionRow);
  }

  /** Lean load for the turn endpoint — status + working draft + env + title only (no turns).
   *  Tenant-scoped; 404 if it isn't this workspace's (the owner check before we stream). */
  async getForTurn(
    tenantId: string,
    id: string,
  ): Promise<{
    id: string;
    status: string;
    environmentId: string | null;
    title: string | null;
    currentGraph: GraphDef | null;
  }> {
    const row = await getPrisma().builderSession.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        environmentId: true,
        title: true,
        currentGraph: true,
      },
    });
    if (!row) {
      throw new NotFoundException("Builder session not found.");
    }
    return {
      id: row.id,
      status: row.status,
      environmentId: row.environmentId,
      title: row.title,
      currentGraph: (row.currentGraph as GraphDef | null) ?? null,
    };
  }

  /**
   * Persist a completed edit turn ATOMICALLY (Slice 2): the user message + the assistant
   * change-summary as two BuilderTurns, and the new working draft on the session — in one
   * transaction, so a partial write can't leave a turn without its graph (or vice-versa). Only
   * writes to an OPEN session (a close that raced the stream wins; the turn is dropped). Sets the
   * title from the first message when it's still unset. Called only after generation SUCCEEDS —
   * on failure nothing is written and the user simply retries.
   */
  async applyTurn(
    tenantId: string,
    id: string,
    input: {
      userMessage: string;
      graph: GraphDef;
      assistantSummary: string;
      costUsd: number;
      titleIfUnset?: string;
    },
  ): Promise<void> {
    await getPrisma().$transaction(async (tx) => {
      // Guard on status inside the txn: if the session closed mid-stream, write nothing.
      const updated = await tx.builderSession.updateMany({
        where: { id, tenantId, status: "open" },
        data: { currentGraph: input.graph as unknown as Prisma.InputJsonValue },
      });
      if (updated.count === 0) return; // closed/gone — drop the turn rather than resurrect it
      // Set the title ONLY if the row still has none — a separate guard on `title: null` so two
      // near-simultaneous first turns can't clobber each other's title (the first to write wins),
      // and a no-op when it's already set (never drops the turn on that account).
      if (input.titleIfUnset) {
        await tx.builderSession.updateMany({
          where: { id, tenantId, title: null },
          data: { title: input.titleIfUnset },
        });
      }
      await tx.builderTurn.create({
        data: { sessionId: id, role: "user", content: input.userMessage },
      });
      await tx.builderTurn.create({
        data: {
          sessionId: id,
          role: "assistant",
          content: input.assistantSummary,
          // Decimal(12,6) — fix to 6 places so we never lose sub-cent precision to float.
          costUsd: new Prisma.Decimal(input.costUsd.toFixed(6)),
        },
      });
    });
  }

  /** Close a session. Idempotent: closing an already-closed session returns it unchanged (the
   *  first close wins, so a save-then-done race doesn't overwrite the reason). */
  async close(
    tenantId: string,
    id: string,
    reason: "saved" | "done" | "abandoned",
  ): Promise<BuilderSessionResponse> {
    // Scope + existence check first (a cross-tenant id must 404, not silently no-op).
    const existing = await getPrisma().builderSession.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new NotFoundException("Builder session not found.");
    }
    if (existing.status !== "closed") {
      // Guard on status in the WHERE so a concurrent close doesn't double-write.
      await getPrisma().builderSession.updateMany({
        where: { id, tenantId, status: { not: "closed" } },
        data: { status: "closed", closedReason: reason, closedAt: new Date() },
      });
    }
    return this.get(tenantId, id);
  }

  /** Open sessions for the resume list — scoped to the ACTIVE environment (a build targets one
   *  env, like variables/graphs), most-recently-touched first. */
  async listOpen(
    tenantId: string,
    environmentId: string,
  ): Promise<BuilderSessionSummaryResponse[]> {
    const rows = await getPrisma().builderSession.findMany({
      where: { tenantId, environmentId, status: "open" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        workflowKey: true,
        title: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      workflowKey: r.workflowKey,
      title: r.title,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}
