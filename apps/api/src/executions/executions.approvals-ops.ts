import { ConflictException } from "@nestjs/common";
import { WorkflowNotFoundError } from "@temporalio/client";
import {
  approvalSignal,
  resumeSignal,
  stateQuery,
  type ExecutionState,
  type ResumeInput,
} from "@naary/contracts";
import type { Principal } from "../auth/tenant.decorator";
import { resumePath } from "./resume-token";
import type { ExecutionsDeps } from "./executions.queries";
import type { BatchDecisionResult } from "./executions.types";

export async function opApprove(
  deps: ExecutionsDeps,
  id: string,
  approved: boolean,
  tenantId: string,
  comment?: string,
  actor?: Principal,
): Promise<void> {
  const row = await deps.assertOwner(id, tenantId);
  await deps.assertRunAccess(actor, "run", row);
  // Slice 1: when the gate names approvers, the deciding principal must match them
  // (owner/admin user principals bypass). No-op when the gate has no routing.
  await deps.assertApprover(actor, id, row.tenantId);
  try {
    await deps.client.workflow.getHandle(id).signal(approvalSignal, {
      approved,
      ...(comment ? { comment } : {}),
      // #576: carry the DISPLAY identity of the decider into the signal so the interpreter can
      // write the AuditEvent for a forced-approval TOOL gate (actor + tool + decision). The API has
      // already authenticated + authorized this principal above — this is a label, never an authz
      // input. Same string shape GraphDefinition.savedBy uses. Absent for an actor-less internal
      // caller, which is why the field is optional in ApprovalInput.
      ...(actor ? { actor: actor.email ?? actor.subject ?? "api-token" } : {}),
    });
  } catch (e) {
    // Signaling a CLOSED workflow (already completed / rejected / failed) returns
    // gRPC NOT_FOUND → WorkflowNotFoundError. The execution row exists (assertOwner
    // passed), so it's not a 404 — it's a 409: the run is no longer awaiting
    // approval. Mirrors getState's WorkflowNotFoundError handling, with the right
    // semantics for a write. (Previously this leaked an unhandled 500.)
    if (e instanceof WorkflowNotFoundError) {
      throw new ConflictException(
        "Execution is not awaiting approval (already completed, rejected, or failed).",
      );
    }
    throw e;
  }
}

export async function opApproveBatch(
  deps: ExecutionsDeps,
  ids: string[],
  approved: boolean,
  tenantId: string,
  comment?: string,
  actor?: Principal,
): Promise<BatchDecisionResult[]> {
  const unique = [...new Set(ids)];
  const settled = await Promise.allSettled(
    unique.map((id) => deps.approve(id, approved, tenantId, comment, actor)),
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { workflowId: unique[i], ok: true }
      : {
          workflowId: unique[i],
          ok: false,
          error:
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

export async function opRemindContext(
  deps: ExecutionsDeps,
  id: string,
  tenantId: string,
  actor?: Principal,
): Promise<{
  environmentId: string;
  workflowId: string;
  workflowKey: string | null;
  title: string;
}> {
  const row = await deps.assertOwner(id, tenantId);
  await deps.assertRunAccess(actor, "run", row);
  let state: ExecutionState;
  try {
    state = await deps.client.workflow.getHandle(id).query(stateQuery);
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new ConflictException(
        "Run is not awaiting approval (already decided, completed, or timed out).",
      );
    }
    throw e;
  }
  if (state.status !== "awaiting_approval") {
    throw new ConflictException(
      "Run is not awaiting approval (already decided, completed, or timed out).",
    );
  }
  const prompt = await deps.approvalPrompt(
    tenantId,
    row.environmentId,
    row.workflowKey,
    state.currentNodeId,
    state.ctx ?? {}, // #1019 — the signed link's title names what is actually being approved
  );
  const environmentId =
    row.environmentId ?? (await deps.environments.defaultEnvId(tenantId));
  return {
    environmentId,
    workflowId: id,
    workflowKey: row.workflowKey,
    title: prompt.title,
  };
}

export async function opResumeByToken(
  deps: ExecutionsDeps,
  workflowId: string,
  payload: unknown,
): Promise<void> {
  try {
    await deps.client.workflow
      .getHandle(workflowId)
      .signal(resumeSignal, { payload } satisfies ResumeInput);
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new ConflictException(
        "Run is not awaiting a webhook resume (already resumed, completed, or timed out).",
      );
    }
    throw e;
  }
}

export async function opDecideByToken(
  deps: ExecutionsDeps,
  workflowId: string,
  approved: boolean,
  comment?: string,
): Promise<void> {
  const handle = deps.client.workflow.getHandle(workflowId);
  // GUARD (public signed link): only decide a run that is CURRENTLY awaiting approval. Temporal
  // buffers a signal sent to a running-but-not-yet-paused run, so without this a stale link
  // clicked later could be "saved up" and auto-satisfy a FUTURE humanApproval pause (a graph that
  // loops or has multiple approvals). Query the live state first; anything but awaiting → 409.
  let status: string;
  try {
    status = (await handle.query(stateQuery)).status;
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new ConflictException("Run not found or already closed.");
    }
    throw e;
  }
  if (status !== "awaiting_approval") {
    throw new ConflictException(
      "Run is not awaiting approval (already decided, completed, or timed out).",
    );
  }
  try {
    await handle.signal(approvalSignal, {
      approved,
      ...(comment ? { comment } : {}),
      // #576: the signed-link path has no principal (that IS the point of the link — the holder of
      // a mailed/Slacked capability decides). Record it honestly as "public-link" rather than
      // leaving the audit row actor-less; the link itself is the authorization.
      actor: "public-link",
    });
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      throw new ConflictException(
        "Run is not awaiting approval (already completed, rejected, or timed out).",
      );
    }
    throw e;
  }
}

export async function opGetResumePath(
  deps: ExecutionsDeps,
  workflowId: string,
  tenantId: string,
  actor?: Principal,
): Promise<string> {
  const row = await deps.assertOwner(workflowId, tenantId);
  // G3 (#593): the minted path is a durable resume CAPABILITY — gate it like every
  // other run-control surface (approve/cancel), not just tenant-scoped.
  await deps.assertRunAccess(actor, "run", row);
  return resumePath(workflowId);
}
