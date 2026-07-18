import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface AuditEventView {
  id: string;
  actor: string;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  createdAt: string;
}

export interface RecordAuditInput {
  tenantId: string;
  actor: string;
  action: string;
  method: string;
  path: string;
  statusCode: number;
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
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      createdAt: r.createdAt.toISOString(),
    }));
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
  if (method === "POST" && is(/\/members$/)) return "Added a member";
  return `${method} ${p}`;
}
