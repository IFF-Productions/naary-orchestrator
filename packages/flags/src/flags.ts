/**
 * Feature flags via OpenFeature, with Flagsmith as the provider. Env-gated + fail-safe,
 * exactly like the repo treats Sentry/object-storage: no key ⇒ the OpenFeature NoopProvider
 * stays and every flag resolves to its SAFE code default (catalog.ts).
 *
 * SECURITY / SCOPING (the answer to "limit access to just the authenticated user"):
 *  - FLAGSMITH_ENVIRONMENT_KEY is the SERVER-SIDE key (`ser.` prefix). It lives in the API
 *    process env ONLY — never shipped to the browser bundle, never returned to a client.
 *  - Evaluation is SERVER-SIDE and keyed on the authenticated tenantId (the OpenFeature
 *    `targetingKey` → Flagsmith identity). A caller only ever learns its OWN tenant's flags
 *    (see GET /me/flags), never another tenant's and never the key.
 *
 * DETERMINISM (Tier-1 rule 2): a flag lookup is a VARYING network call. Do NOT import this
 * from workflow code — resolve flags in an activity and pass the value into the workflow.
 */
import { FlagsmithOpenFeatureProvider } from "@openfeature/flagsmith-provider";
import { type EvaluationContext, OpenFeature } from "@openfeature/server-sdk";
import { Flagsmith } from "flagsmith-nodejs";
import { ALL_FLAG_SPECS, FLAG_CATALOG, type FlagKey } from "./catalog";

/** Platform-level Flagsmith config, from env. Null when flags aren't configured. */
export interface FlagsConfig {
  /** SERVER-SIDE environment key (`ser.` prefix). Never sent to the browser. */
  environmentKey: string;
  /** Self-hosted Flagsmith API base (e.g. https://flags.internal/api/v1/). Omit for SaaS. */
  apiUrl?: string;
}

export function flagsConfig(): FlagsConfig | null {
  const environmentKey = process.env.FLAGSMITH_ENVIRONMENT_KEY;
  if (!environmentKey) return null;
  return { environmentKey, apiUrl: process.env.FLAGSMITH_API_URL || undefined };
}

/** Test seam so unit tests can drive init/config without real env or network. */
export const __flagsDeps = {
  config: flagsConfig,
  buildProvider: (cfg: FlagsConfig): FlagsmithOpenFeatureProvider =>
    new FlagsmithOpenFeatureProvider(
      new Flagsmith({
        environmentKey: cfg.environmentKey,
        ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      }),
      // Prefer Flagsmith's own default over throwing FlagNotFoundError — combined with
      // getBooleanValue (which never throws), a missing/unreachable flag degrades to default.
      { useFlagsmithDefaults: true },
    ),
};

let initialized = false;

/**
 * Wire the OpenFeature provider once, at API boot. FAIL-SAFE by construction:
 *  - No config ⇒ leave the NoopProvider (code defaults). Returns false.
 *  - Config present ⇒ setProvider (NON-awaited): boot NEVER blocks on a Flagsmith fetch, and
 *    until the provider warms up, evals return code defaults rather than hanging. Any synchronous
 *    construction error is swallowed (Noop stays). Returns true.
 * Idempotent — safe to call more than once.
 */
export function initFlags(): boolean {
  if (initialized) return true;
  const cfg = __flagsDeps.config();
  if (!cfg) return false;
  try {
    // Deliberately NOT setProviderAndWait — a down/slow Flagsmith must not stall API startup.
    OpenFeature.setProvider(__flagsDeps.buildProvider(cfg));
    initialized = true;
    return true;
  } catch {
    // Construction failed — stay on Noop (code defaults). Flags off, app healthy.
    return false;
  }
}

/** Reset back to the built-in Noop provider (tests only). */
export async function __resetFlags(): Promise<void> {
  initialized = false;
  await OpenFeature.clearProviders();
}

/** Graceful shutdown — close the provider (stops any Flagsmith polling/keep-alive). */
export async function shutdownFlags(): Promise<void> {
  await OpenFeature.close();
  initialized = false;
}

/** The evaluation context for a tenant — targetingKey drives Flagsmith identity targeting. */
function ctxFor(tenantId: string): EvaluationContext {
  return { targetingKey: tenantId };
}

/**
 * Resolve a single boolean flag for a tenant. getBooleanValue NEVER throws — a provider error,
 * missing flag, or un-warmed provider all resolve to `defaultValue` — so this is safe on any path.
 * Prefer the catalog default: `flag(key, FLAG_CATALOG[key].default, tenantId)`.
 */
export function flag(
  key: FlagKey,
  defaultValue: boolean,
  tenantId: string,
): Promise<boolean> {
  return OpenFeature.getClient().getBooleanValue(
    key,
    defaultValue,
    ctxFor(tenantId),
  );
}

/**
 * Resolve the WHOLE catalog for a tenant — the data behind GET /me/flags. Returns only
 * booleans (never the provider/key), scoped to this tenant. Each miss falls back to its
 * catalog default, so the shape is stable regardless of provider health.
 */
export async function getAllFlags(
  tenantId: string,
): Promise<Record<FlagKey, boolean>> {
  const client = OpenFeature.getClient();
  const ctx = ctxFor(tenantId);
  const entries = await Promise.all(
    ALL_FLAG_SPECS.map(
      async (spec) =>
        [
          spec.key,
          await client.getBooleanValue(spec.key, spec.default, ctx),
        ] as const,
    ),
  );
  // Keys come from the catalog, so the map is exactly the known FlagKey set.
  return Object.fromEntries(entries) as Record<FlagKey, boolean>;
}
