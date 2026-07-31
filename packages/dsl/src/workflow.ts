/**
 * The DETERMINISTIC-SAFE entry point of @naary/dsl (#910).
 *
 * READ THIS BEFORE ADDING AN EXPORT.
 *
 * `apps/worker/src/temporal/workflow/**` is compiled by `bundleWorkflowCode` into the
 * Temporal workflow bundle: the code every worker loads at boot and every REPLAY of every
 * in-flight run re-evaluates. This package is CJS with `"main": "dist/index.js"` and no
 * `"exports"` map, so `export *` in the barrel compiles to `__exportStar` and NOTHING
 * tree-shakes — importing a single symbol from `@naary/dsl` executes all ~50 modules,
 * including the 161KB integration catalog (down to its UI hint strings) and zod (#926). The
 * IMPORT PATH is therefore the only lever: moving code between modules changes nothing
 * unless the importer changes too.
 *
 * So workflow code imports `@naary/dsl/dist/workflow` — this file — which re-exports ONLY
 * from modules that are pure, small, and free of the catalog and the authoring-time
 * machinery. Same precedent as `./registry` and `./n8n-import`, which the barrel
 * deliberately does not re-export (for zod and importer weight respectively).
 *
 * RULES:
 *  - Re-export only from modules whose transitive `require` graph is catalog-free.
 *    `apps/worker/test/workflow-bundle.spec.ts` enforces this against the REAL
 *    `bundleWorkflowCode` output — if a catalog string reappears in the bundle, it fails.
 *  - Types are erased at compile time, so a type-only import from the barrel costs
 *    nothing; they are re-exported here purely so workflow files can use one path.
 *  - A module listed here must not `require` a validation/parsing library. #926 closed the
 *    last one: `./template-blocks` imported zod for `templateBlockSchema`, so exporting the
 *    pure `renderEmailHtml` dragged ALL of zod in. The schemas moved to
 *    `./template-blocks-schema`; the same bundle spec now fails if zod reappears.
 */

// ── Pure value helpers the interpreter calls ────────────────────────────────────────────
export { evaluateCondition, nextNodes } from "./branch";
export { getByPath, resolveMcpArguments, bindingNamesSource } from "./mcp-args";
export {
  resolveTemplates,
  resolveTemplateString,
  collectUnresolved,
} from "./template";
export {
  computeItemsRegions,
  BATCHABLE_REGION_ACTIVITIES,
} from "./items-region";
// Retry regions (retry…retryEnd). Zod-free and catalog-free by construction, so it is safe for the
// deterministic bundle — the interpreter computes the same regions the save gate validated.
export {
  computeRetryRegions,
  retryBackoffMs,
  type ResolvedRetryPolicy,
  type RetryRegion,
} from "./retry-region";
export { asNodeConfig } from "./node-config";
export { getNodeOutput } from "./node-output";

// Node resolvers (one per node kind) — all pure graph traversal.
export { resolveHttpRequest } from "./http-request";
export { resolveGraphQL } from "./graphql";
export { resolveSqlQuery, resolveSqlExec } from "./sql-query";
export { resolveRss } from "./rss";
export { resolveIf } from "./if-node";
export { resolveJson } from "./json-node";
export { resolveNumber } from "./number-node";
export { resolveSet } from "./set-node";
export { resolveSwitch } from "./switch-node";
export { resolveText } from "./text-node";
export { resolveRenameKeys } from "./rename-keys";
export {
  resolveFilter,
  resolveAggregate,
  resolveListOps,
  resolveCompareDatasets,
} from "./array-nodes";
export { resolveSubWorkflowInput } from "./sub-workflow";
export { resolveWebhookResponse } from "./respond-webhook";
export { resolveHmac, resolveJwt, resolveHash } from "./signing";
export { resolveSendEmail } from "./send-email";
export { renderEmailHtml, escapeHtml } from "./template-blocks";
export { collectCitations } from "./citations";
export { integrationToolRef, mcpToolRef } from "./guardrails";

// Integration nodes: field resolution is catalog-free, and the write/read (at-most-once
// vs retryable) decision comes from the derived write-set rather than the catalog. See
// ./integration-write for why that is safe and what test holds it in place.
export { resolveIntegrationFields } from "./integration-fields";
export {
  isIntegrationWriteAction,
  INTEGRATION_WRITE_ACTIONS,
} from "./integration-write";

// ── Types (erased; re-exported so workflow files need only one import path) ─────────────
export type {
  ArgBinding,
  ApprovalNodeConfig,
  EdgeCondition,
  EdgeDef,
  GraphDef,
  IntegrationNodeConfig,
  NodeDef,
  NodeRetryPolicy,
  NodeType,
} from "./types";
export type { ItemsRegion, TraceCell, RegionTrace } from "./items-region";
export type { NodeConfigMap, ConfigForType } from "./node-config";
export type { NodeOutputMap, NodeOutput } from "./node-output";
export type { UnresolvedRef, TemplateToken, TemplateWarning } from "./template";
export type { ResolvedHttpRequest } from "./http-request";
export type { ToolPolicyVerdict, GraphToolRef } from "./guardrails";
export type { TemplateBlock } from "./template-blocks";
