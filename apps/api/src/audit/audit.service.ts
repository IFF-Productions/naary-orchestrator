import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface AuditEventView {
  id: string;
  /** The STORED actor: a Firebase uid, an `sso:…` id, or "api-token". Stable and never rewritten. */
  actor: string;
  /**
   * The actor's email from their Membership in this workspace, or null when it can't be resolved (an
   * API token, a member who left, or a Membership predating the email stamp — the column is nullable
   * and documents itself as "email at join time").
   *
   * A SEPARATE field rather than rewriting `actor`, deliberately: an audit log's actor must stay
   * stable and unambiguous, and emails get reassigned between people while ids don't. Callers render
   * `actorEmail ?? actor` and keep the id available. Never a fabricated value — a miss is null.
   */
  actorEmail: string | null;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  /** Canonical Environment.id the actor had selected (#464); null when none. */
  environmentId: string | null;
  createdAt: string;
}

export interface RecordAuditInput {
  tenantId: string;
  actor: string;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  /** Canonical Environment.id (already resolved by the caller); omit/null for none. */
  environmentId?: string | null;
}

/** Append-only activity log. Writes are best-effort (an audit failure must never
 *  break the request it records); reads are tenant-scoped, newest first. */
@Injectable()
export class AuditService {
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await getPrisma().auditEvent.create({ data: input });
    } catch {
      /* best-effort — never fail a request because its audit row didn't write */
    }
  }

  async list(tenantId: string, limit = 100): Promise<AuditEventView[]> {
    const rows = await getPrisma().auditEvent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const emails = await this.actorEmails(
      tenantId,
      rows.map((r) => r.actor),
    );
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      actorEmail: emails.get(r.actor) ?? null,
      action: r.action,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      environmentId: r.environmentId ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Map stored actor ids → the email on their Membership in THIS workspace.
   *
   * Resolved on READ rather than stamped at write time, because that's what fixes the rows already in
   * the log — a write-side change alone would leave the screen showing raw uids until new events
   * accrued. The stored row stays byte-identical either way, so the log's integrity is untouched;
   * only its presentation improves.
   *
   * ONE batched query, not one per row: the audit list serves up to 200 rows, and a per-row lookup
   * would be a 200-query page.
   *
   * No "is this a uid?" discriminator is needed. `actor` is always `principal.subject` (a Firebase uid
   * or an `sso:…` id — both of which ARE the `Membership.userId`) or the literal "api-token" for token
   * principals, which simply misses. Guessing at the shape would be a branch that can only be wrong.
   *
   * Scoped by tenantId as well as userId: `Membership` is per-workspace and indexed on `userId` alone,
   * so querying by id without the tenant would reach across workspaces.
   */
  private async actorEmails(
    tenantId: string,
    actors: string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(actors)];
    if (ids.length === 0) return new Map();
    const members = await getPrisma().membership.findMany({
      where: { tenantId, userId: { in: ids } },
      select: { userId: true, email: true },
    });
    const out = new Map<string, string>();
    for (const m of members) {
      // `email` is nullable ("email at join time") — a member who predates the stamp has none, and
      // that must surface as null rather than as an invented placeholder.
      if (m.email) out.set(m.userId, m.email);
    }
    return out;
  }
}

/**
 * Human-readable action label from an HTTP method + path. Path IDs are ignored by
 * matching on the trailing segment(s), so it's stable regardless of tenant/resource id.
 * Falls back to "METHOD /path" for anything unmapped (still a useful audit line).
 */
export function actionFor(method: string, path: string): string {
  const p = path.replace(/\/+$/, "");
  const is = (re: RegExp) => re.test(p);
  if (method === "POST" && is(/\/graphs\/generate$/))
    return "Generated a workflow with AI";
  // SSE variant; statusCode is always 200 here (errors travel as stream frames).
  if (method === "POST" && is(/\/graphs\/generate\/stream$/))
    return "Generated a workflow with AI";
  if (method === "POST" && is(/\/graphs$/)) return "Saved a workflow";
  if (method === "PUT" && is(/\/graphs\/[^/]+\/error-handler$/))
    return "Changed an error handler";
  if (method === "POST" && is(/\/executions\/[^/]+\/approve$/))
    return "Decided an approval";
  if (method === "POST" && is(/\/executions$/)) return "Started a run";
  if (method === "POST" && is(/\/connections$/)) return "Added a connection";
  if (method === "DELETE" && is(/\/connections\/[^/]+$/))
    return "Removed a connection";
  if (method === "PUT" && is(/\/credentials$/)) return "Saved a provider key";
  if (method === "DELETE" && is(/\/credentials\/[^/]+$/))
    return "Removed a provider key";
  if (method === "PUT" && is(/\/settings$/)) return "Updated settings";
  if (method === "PUT" && is(/\/notifications$/))
    return "Updated notifications";
  if (method === "PUT" && is(/\/budget$/)) return "Updated the budget";
  if (method === "POST" && is(/\/schedules$/)) return "Created a schedule";
  if (method === "DELETE" && is(/\/schedules\/[^/]+$/))
    return "Removed a schedule";
  if (method === "POST" && is(/\/webhooks$/)) return "Registered a webhook";
  if (method === "DELETE" && is(/\/webhooks\/[^/]+$/))
    return "Removed a webhook";
  // Permission groups (G3) — matched BEFORE the member routes: a group's member/token
  // attach also ends in /members/:id, and the /groups/ segment must win.
  if (method === "POST" && is(/\/groups\/[^/]+\/members\/[^/]+$/))
    return "Added a member to a permission group";
  if (method === "DELETE" && is(/\/groups\/[^/]+\/members\/[^/]+$/))
    return "Removed a member from a permission group";
  if (method === "POST" && is(/\/groups\/[^/]+\/tokens\/[^/]+$/))
    return "Added an API token to a permission group";
  if (method === "DELETE" && is(/\/groups\/[^/]+\/tokens\/[^/]+$/))
    return "Removed an API token from a permission group";
  if (method === "POST" && is(/\/groups\/[^/]+\/grants$/))
    return "Changed workflow permissions";
  if (method === "PATCH" && is(/\/groups\/[^/]+\/grants\/[^/]+$/))
    return "Changed workflow permissions";
  if (method === "DELETE" && is(/\/groups\/[^/]+\/grants\/[^/]+$/))
    return "Removed a workflow permission grant";
  if (method === "POST" && is(/\/groups$/)) return "Created a permission group";
  if (method === "PATCH" && is(/\/groups\/[^/]+$/))
    return "Renamed a permission group";
  if (method === "DELETE" && is(/\/groups\/[^/]+$/))
    return "Deleted a permission group";
  // Team routes (U1: POST invites; the invitations DELETE must precede the generic
  // /members/:userId DELETE — both would match it).
  if (method === "POST" && is(/\/members$/)) return "Invited a member";
  if (method === "PATCH" && is(/\/members\/[^/]+$/))
    return "Changed a member's role";
  if (method === "DELETE" && is(/\/members\/invitations\/[^/]+$/))
    return "Revoked an invitation";
  if (method === "DELETE" && is(/\/members\/[^/]+$/)) return "Removed a member";
  return `${method} ${p}`;
}
