import { platformOperators } from "../config";
import type { Principal } from "./tenant.decorator";

/**
 * PLATFORM OPERATOR — whoever runs this deployment, as distinct from whoever owns a workspace inside
 * it. Pure (env + a principal); unit-tested in test/platform-operators.spec.ts.
 *
 * ## Why workspace role could not express this
 *
 * `WorkersController` used to gate the fleet view on `principal.role === "owner" | "admin"`. That is
 * the caller's role in their OWN workspace, and in self-serve SaaS everyone who signs up owns one — so
 * the check admitted every customer. Since `WorkerHeartbeat` carries no tenantId, the endpoint returns
 * the whole global fleet: hostnames, PIDs, worker versions and live slot counts. A customer could read
 * the platform's infrastructure inventory and infer from the slot numbers how loaded it is.
 *
 * Fine for a self-hosted install, where the deployment and the workspace owner are the same person.
 * Wrong the moment it is multi-tenant. Operating the instance is simply not a workspace-scoped fact, so
 * it needs its own signal.
 *
 * ## FAIL CLOSED
 *
 * With `PLATFORM_OPERATORS` unset, NOBODY is an operator — the fleet endpoint 403s for everyone and the
 * SPA hides the nav entry entirely. That is a deliberate change from the previous behaviour (where any
 * workspace owner qualified): a security posture that depends on remembering to set an env var isn't
 * one. A self-hosted operator who wants the view back sets their own email.
 */

/** Comma-separated operator emails. Unset/empty ⇒ no operators at all (see FAIL CLOSED above). */
export function platformOperatorEmails(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Lowercased by the accessor — an operator typing Sam@Acme.io must still match.
  return platformOperators(env);
}

/**
 * Is this principal a platform operator?
 *
 * Matched on EMAIL, not user id: operators are people the deployment's owner names in config, and an
 * email is the identifier they actually have to hand. API-token principals carry no email, so a token
 * can never be an operator — correct, since infra telemetry is not something a workflow's automation
 * credential should be able to read.
 */
export function isPlatformOperator(
  principal: Principal | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const email = principal?.email?.trim().toLowerCase();
  if (!email) return false;
  const allowed = platformOperatorEmails(env);
  // Empty list ⇒ closed. Written explicitly so the fail-closed behaviour can't be lost to a refactor
  // that makes `[].includes(...)` look like an accident.
  if (allowed.length === 0) return false;
  return allowed.includes(email);
}
