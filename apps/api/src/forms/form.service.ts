import { BadRequestException, Injectable } from "@nestjs/common";
import { type FormEndpoint, getPrisma } from "@naary/db";
import { getBudget } from "@naary/usage";

/** A freshly registered form — the path is the public URL to host/share. */
export interface RegisteredForm {
  formId: string;
  /** Public path to serve the form + accept submissions (host is deployment-specific). */
  formPath: string;
}

/** Public view of a registered form endpoint (management list). */
export interface FormEndpointView {
  id: string;
  workflowId: string;
  createdAt: Date;
}

@Injectable()
export class FormService {
  /**
   * Register a hosted form for a workflow. Unlike a webhook there is no secret to mint — the
   * opaque `id` IS the capability. But because the resulting endpoint is a PUBLIC, anonymous
   * workflow-start surface that can spend the tenant's BYOK LLM budget, we refuse to create one
   * unless the tenant has a monthly spend cap configured: the cap (enforced per-LLM-call by the
   * agent activity's atomic reservation) is the backstop against cost amplification from a flood.
   */
  async createEndpoint(
    tenantId: string,
    workflowId: string,
  ): Promise<RegisteredForm> {
    // INVARIANT this gate leans on: budgets have no DELETE path (budget.controller exposes only
    // GET/PUT). This is a point-in-time check — there's no per-form re-check at run time — so if a
    // budget-delete is ever added, every existing public form silently reopens the uncapped hole.
    // Guard that change here (or add a run-time re-check) before allowing budget deletion.
    const budget = await getBudget(tenantId);
    if (!budget) {
      throw new BadRequestException(
        "Set a monthly budget for this tenant before exposing a public form — " +
          "an anonymous endpoint needs a spend cap.",
      );
    }
    const row = await getPrisma().formEndpoint.create({
      data: { tenantId, workflowId },
    });
    return { formId: row.id, formPath: `/forms/${row.id}` };
  }

  /** List the tenant's form endpoints (newest first). */
  list(tenantId: string): Promise<FormEndpointView[]> {
    return getPrisma().formEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, workflowId: true, createdAt: true },
    });
  }

  /** Delete a tenant's form endpoint by id (tenant-scoped). Returns true if a row was removed;
   *  any inbound call to that form then 404s. */
  async deleteEndpoint(tenantId: string, formId: string): Promise<boolean> {
    const res = await getPrisma().formEndpoint.deleteMany({
      where: { id: formId, tenantId },
    });
    return res.count > 0;
  }

  getEndpoint(formId: string): Promise<FormEndpoint | null> {
    return getPrisma().formEndpoint.findUnique({ where: { id: formId } });
  }
}
