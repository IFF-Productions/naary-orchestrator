// Worker-side AuditEvent writes (#576).
//
// WHY THIS EXISTS: before this, `AuditEvent` had exactly ONE writer — the API's global
// AuditInterceptor, which needs a mutating HTTP request WITH a principal. Two of #576's audit
// obligations have neither:
//   1. a guardrail VIOLATION detected inside the agent activity (no request at all), and
//   2. a forced-approval tool DECISION, which the interpreter observes as a Signal — and which the
//      public signed-link decide path never audited at all (it has no `req.principal`).
// So the worker gets its own narrow, append-only writer. It records the same columns the
// interceptor does so both kinds of row read identically in the audit list.
//
// PRIVACY (Tier-1 rule 4 posture): `action`/`path` carry ids, tool refs, and rule LABELS only —
// never prompt text, never a matched string, never a credential. The caller is responsible for
// that; every call site in this repo is reviewed on that basis.
import { getPrisma } from "@naary/db";
import { createLogger } from "@naary/logging";

const log = createLogger({ component: "worker" });

/** Pseudo-"method" marking a row written by the worker rather than an HTTP request. */
export const WORKER_AUDIT_METHOD = "WORKER";

/** Actor recorded when the enforcement was automatic (no human involved). */
export const GUARDRAIL_ACTOR = "guardrail";

export interface AuditEventInput {
  tenantId: string;
  /** Display identity of whoever caused the event; {@link GUARDRAIL_ACTOR} when automatic. */
  actor: string;
  /** Human label, e.g. "Approved tool github:create_issue". Ids/refs/labels only. */
  action: string;
  /** Resource-ish path, e.g. "/executions/<workflowId>/nodes/<nodeId>". */
  path: string;
  /** 200 = recorded/allowed, 403 = blocked. Mirrors how an HTTP row reads. */
  statusCode: number;
  environmentId?: string;
}

/**
 * Append one audit row. BEST-EFFORT by design (same posture as `AuditService.record`): an audit
 * write must never fail the run that it describes, so every error is swallowed and logged. The
 * enforcement itself already happened before this is called — this only records it.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await getPrisma().auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actor: input.actor,
        action: input.action,
        method: WORKER_AUDIT_METHOD,
        path: input.path,
        statusCode: input.statusCode,
        environmentId: input.environmentId ?? null,
      },
    });
  } catch (e) {
    log.warn(
      {
        activity: "recordAuditEvent",
        tenantId: input.tenantId,
        action: input.action,
        error: e instanceof Error ? e.message : String(e),
      },
      "audit event write failed (ignored — never blocks the run)",
    );
  }
}
