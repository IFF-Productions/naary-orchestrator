/**
 * Declarative integration catalog (design docs/design/INTEGRATION-NODES.md).
 *
 * A single `integration` node type is parameterized by { provider, action } that index
 * into this catalog: provider → action → { method, pathTemplate, write, fields }. The
 * catalog is the ONE source of truth for the config-panel UI, the activity's request
 * construction, the save-gate validator, the per-node docs, and the tests — so nothing
 * can drift. Adding an integration is a catalog entry, not a new node type (Tier-1:
 * interpreter, not codegen).
 *
 * THIS FILE IS NOW A BARREL. It was a single 5,111-line module, of which 4,600 lines were data:
 * a two-line fix to the request builder and a new PagerDuty field arrived in the same file and
 * the same review, and every concurrent provider edit conflicted. The split under ./integrations/
 * is a pure move — every symbol below is the one that was here, re-exported BY NAME so that no
 * import site anywhere changes. By name and not `export *`: the 38 provider consts are internal
 * to ./integrations/ and must not leak into the public surface.
 *
 *   ./integrations/types.ts            the shapes (IntegrationProvider / Action / Field, RetiredField)
 *   ./integrations/providers/<key>.ts  one file per provider, named for its catalog key
 *   ./integrations/catalog.ts          assembles INTEGRATION_CATALOG + INTEGRATION_PROVIDERS
 *   ./integrations/lookup.ts           getIntegrationProvider / getIntegrationAction
 *   ./integrations/build-request.ts    buildIntegrationRequest (+ BuiltIntegrationRequest)
 *   ./integrations/validate.ts         validateIntegrationConfig — the save gate
 *
 * ONE FILE PER PROVIDER rather than per domain: they run 51–278 lines, ~121 on average, and a
 * provider is the unit people actually change — added, edited and reviewed alone. A "comms" or
 * "dev tools" grouping would put unrelated providers back in one diff, which is the problem this
 * split exists to remove. Each provider file opens with a banner naming its base URL, auth scheme
 * and quirks; it does not repeat this paragraph 38 times.
 *
 * Pure + dependency-free (no zod, no I/O), but NOT small: 38 providers with every action,
 * field and UI hint string is ~161KB. It must therefore stay OUT of the deterministic Temporal
 * workflow bundle (#910) — the config panel, the activity's request construction, the save gate
 * and the docs generator all load it happily; the interpreter must not. The two helpers the
 * interpreter genuinely needs live in ./integration-fields and ./integration-write, which are
 * catalog-free. Nothing in this file, and nothing under ./integrations/, may be imported from
 * `apps/worker/src/temporal/workflow/**`; `apps/worker/test/workflow-bundle.spec.ts` fails the
 * build if it is.
 */

// `resolveIntegrationFields` + `isEmptyFieldValue` moved to a catalog-free module (#910) so the
// interpreter can reach them without loading this file. Re-exported here (and from the barrel via
// ./integration-fields) so every existing import site keeps working unchanged.
export {
  resolveIntegrationFields,
  isEmptyFieldValue,
} from "./integration-fields";

export type {
  FieldLocation,
  FieldType,
  IntegrationField,
  IntegrationAction,
  RetiredField,
  IntegrationProvider,
} from "./integrations/types";
export {
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
} from "./integrations/catalog";
export {
  getIntegrationProvider,
  getIntegrationAction,
} from "./integrations/lookup";
export {
  buildIntegrationRequest,
  type BuiltIntegrationRequest,
} from "./integrations/build-request";
export { validateIntegrationConfig } from "./integrations/validate";
