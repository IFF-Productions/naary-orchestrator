import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { AgentGuardrailPolicy } from "@naary/dsl";
// Deep `dist/registry` import for the same reason graphs.service.ts uses it: the zod layer must
// never ride the worker's `@naary/dsl` import surface (Tier-1 rule 2), so it is not re-exported
// from the package index, and classic `moduleResolution: node` can't honour an exports subpath.
import {
  agentGuardrailPolicySchema,
  InvalidGuardrailPolicyError,
  parseAgentGuardrailPolicy,
} from "@naary/dsl/dist/registry";

/**
 * Workspace-level agent guardrail policy (#576), stored on `TenantSettings.agentGuardrails`.
 *
 * Read by: this API (the Settings screen), the graph SAVE GATE (`GraphsService.upsert`), and the
 * worker (in-activity enforcement + the interpreter's forced-approval gate) — three independent
 * enforcement points, which is the "defense in depth" the issue asks for.
 */
@Injectable()
export class GuardrailsService {
  /** The tenant's policy, or `{}` when none is configured. Throws 400 on a malformed stored row
   *  (fail closed + visible — see parseAgentGuardrailPolicy). */
  async get(tenantId: string): Promise<AgentGuardrailPolicy> {
    const row = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { agentGuardrails: true },
    });
    try {
      return parseAgentGuardrailPolicy(row?.agentGuardrails ?? null);
    } catch (e) {
      if (e instanceof InvalidGuardrailPolicyError) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  /**
   * Replace the policy. WHOLE-OBJECT PUT, not a patch: a partial merge on a blocklist is a
   * footgun (you'd never be able to remove a rule), and the Settings screen always holds the
   * full object. `strict()` zod means a typo'd key is a 400, never a silently-unenforced rule.
   */
  async save(tenantId: string, policy: unknown): Promise<AgentGuardrailPolicy> {
    const parsed = agentGuardrailPolicySchema.safeParse(policy ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid guardrail policy — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "policy"} ${i.message}`)
          .join("; ")}`,
      );
    }
    const value = parsed.data as object;
    await getPrisma().tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId, agentGuardrails: value },
      update: { agentGuardrails: value },
    });
    return parsed.data;
  }
}
