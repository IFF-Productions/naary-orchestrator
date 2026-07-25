// Agent guardrails (#576) — the worker's policy READ + the interpreter's tool-policy projection.
//
// Enforcement itself is split by where the call happens:
//   - agent.ts (in-activity)   → deny-list, content rules, PII redaction for the model call
//   - node-exec.ts (workflow)  → the forced-approval PAUSE before a standalone tool node runs,
//                                using the projection this module's activity returns
//
// Tier-1 rule 3: the DB read lives here, in an activity/helper the workflow reaches only via a
// proxy. Tier-1 rule 2: what crosses back into workflow code is a small deterministic map of
// `ref → verdict`, never the policy internals.
import { getPrisma } from "@naary/db";
import { ApplicationFailure } from "@temporalio/activity";
import {
  type AgentGuardrailPolicy,
  evaluateToolPolicy,
  type ToolPolicyVerdict,
} from "@naary/dsl";
// Deep dist import (see graphs.service.ts:18 for the full reasoning): the zod layer must not ride
// the `@naary/dsl` package index, which the deterministic workflow bundle imports.
import {
  InvalidGuardrailPolicyError,
  parseAgentGuardrailPolicy,
} from "@naary/dsl/dist/registry";

/**
 * Test seam mirroring `__agentDeps`: the policy source, swappable so enforcement can be exercised
 * without a live DB.
 */
export const __guardrailDeps = {
  readPolicyRow: async (tenantId: string): Promise<unknown> => {
    const row = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { agentGuardrails: true },
    });
    return row?.agentGuardrails ?? null;
  },
};

/**
 * The workspace's policy, freshly read (NOT cached): a workspace admin tightening a blocklist must
 * take effect on the next node, and workers are stateless by Tier-1 rule 7.
 *
 * A malformed stored policy is a NON-RETRYABLE failure, not a silent "no guardrails" — a
 * governance control that stops enforcing because a row got corrupted is the worst outcome
 * available, and retrying can't fix a bad row (only an admin can).
 */
export async function loadGuardrailPolicy(
  tenantId: string,
): Promise<AgentGuardrailPolicy> {
  const raw = await __guardrailDeps.readPolicyRow(tenantId);
  try {
    return parseAgentGuardrailPolicy(raw);
  } catch (e) {
    if (e instanceof InvalidGuardrailPolicyError) {
      throw ApplicationFailure.nonRetryable(
        `This workspace's agent guardrail policy is invalid and cannot be enforced — fix it in Settings. (${e.message})`,
        "GUARDRAIL_POLICY_INVALID",
        { tenantId },
      );
    }
    throw e;
  }
}

/**
 * The verdict map the interpreter memoizes under `ctx.__toolPolicy`.
 *
 * TOTAL over the refs asked about — an "allow" verdict is recorded EXPLICITLY. That is
 * security-critical: if "allow" were represented by absence, a key MISS would be
 * indistinguishable from a permitted tool, and any ref the interpreter had not pre-registered
 * would sail through even under `deny: ["*"]`. Absence means "not yet evaluated", never "allowed".
 */
export type ToolPolicyProjection = Record<string, ToolPolicyVerdict>;

export interface ResolveToolPolicyInput {
  tenantId: string;
  /** The tool refs to evaluate — the RESOLVED refs the interpreter is about to call. */
  refs: string[];
}

/**
 * ACTIVITY. Evaluate the workspace policy for the given tool refs.
 *
 * Deliberately returns a verdict map rather than the policy object: the interpreter should not
 * carry (or write into Temporal history) the operator's full blocklist, and keeping the matcher
 * here means workflow code holds no policy-interpretation logic to keep in sync.
 */
export async function resolveToolPolicy(
  input: ResolveToolPolicyInput,
): Promise<ToolPolicyProjection> {
  const policy = await loadGuardrailPolicy(input.tenantId);
  const out: ToolPolicyProjection = {};
  for (const ref of input.refs) {
    out[ref] = evaluateToolPolicy(ref, policy);
  }
  return out;
}
