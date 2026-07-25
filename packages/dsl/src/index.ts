export * from "./types";
export {
  sampleGraph,
  webhookSampleGraph,
  githubReviewGraph,
  httpEnrichGraph,
  sqlEnrichGraph,
  graphRegistry,
  getGraphForWorkflow,
} from "./sample-graph";
export {
  feedDigestGraph,
  supportReplyGraph,
  dbReportGraph,
  moderationGraph,
  apiEnrichGraph,
  githubIssueTriageGraph,
  jiraTicketGraph,
} from "./templates";
export { getByPath, resolveMcpArguments } from "./mcp-args";
export {
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
  getIntegrationProvider,
  getIntegrationAction,
  resolveIntegrationFields,
  buildIntegrationRequest,
  validateIntegrationConfig,
  type IntegrationProvider,
  type IntegrationAction,
  type IntegrationField,
  type BuiltIntegrationRequest,
} from "./integrations";
export {
  planIntegrationCall,
  pickConnectionTestAction,
  type IntegrationCallPlan,
  type IntegrationCallPlanInput,
  type ConnectionTestProbe,
} from "./integration-request";
export {
  resolveTemplates,
  resolveTemplateString,
  templateTokens,
  lintTemplates,
  lintBindings,
  collectUnresolved,
  isSecretRef,
  type TemplateToken,
  type TemplateWarning,
  type UnresolvedRef,
} from "./template";
export { isPureNode, runPureNode } from "./pure-node";
// Items model (design ITEMS-MODEL.md) — Slice 1 normalize primitive only; no interpreter change yet.
export { type Item, toItems, itemsJson } from "./items";
export {
  computeItemsRegions,
  BATCHABLE_REGION_ACTIVITIES,
  type ItemsRegion,
  type ItemsRegionResult,
  type TraceCell,
  type RegionTrace,
} from "./items-region";
export { resolveHttpRequest, type ResolvedHttpRequest } from "./http-request";
export { resolveGraphQL, type ResolvedGraphQL } from "./graphql";
export { parseCurl, type CurlImportResult } from "./curl-import";
// The n8n importer (#579) is deliberately NOT re-exported here. Workflow code imports this barrel
// for real values (computeItemsRegions, resolveHmac, …), so anything reachable from it lands in the
// deterministic workflow bundle — and ~1300 lines of one-shot authoring-time translation has no
// business there (Tier-1 rule 2; same reasoning that keeps zod behind ./registry). The API imports
// `@naary/dsl/dist/n8n-import` directly, mirroring graphs.service.ts's `@naary/dsl/dist/registry`.
export {
  parseOpenApi,
  parseIntrospection,
  GRAPHQL_INTROSPECTION_QUERY,
  type ApiOperation,
  type OpenApiSummary,
  type GraphQLField,
  type GraphQLTypeSummary,
  type GraphQLSchemaSummary,
} from "./introspection";
export {
  resolveSqlQuery,
  type ResolvedSqlQuery,
  resolveSqlExec,
  type ResolvedSqlExec,
} from "./sql-query";
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
export {
  resolveHmac,
  resolveJwt,
  resolveHash,
  type ResolvedHmac,
  type ResolvedJwt,
  type ResolvedHash,
} from "./signing";
export { resolveSendEmail, type ResolvedSendEmail } from "./send-email";
export {
  type TemplateBlock,
  renderEmailHtml,
  escapeHtml,
  templateBlockSchema,
  templateBlocksSchema,
} from "./template-blocks";
export { resolveRss, type ResolvedRss } from "./rss";
export {
  resolveWebhookResponse,
  type ResolvedWebhookResponse,
} from "./respond-webhook";
export { collectCitations, type DerivedCitation } from "./citations";
export { walk } from "./walk";
export { canonicalize } from "./canonical";
export {
  diffGraphs,
  graphsEqual,
  type GraphDiff,
  type NodeChange,
} from "./graph-diff";
export {
  NODE_CATALOG,
  NODE_TYPES,
  CONDITION_OPS,
  nodeCatalogPrompt,
  type NodeCatalogEntry,
  type NodeGroup,
} from "./node-catalog";
export {
  evaluateCondition,
  nextNodes,
  validateGraph,
  type GraphValidation,
} from "./branch";
// Runtime-free typed config accessor (Phase 2·2). Registry config TYPES are re-exported here for
// the worker; the runtime schemas/validation stay behind ./registry so zod never enters the
// worker's import surface (Tier-1 rule 2). node-config.ts uses `import type` only → no zod.
export {
  asNodeConfig,
  type NodeConfigMap,
  type ConfigForType,
} from "./node-config";
// Runtime-free typed OUTPUT accessor (mirror of node-config). `import type` only → no zod in the
// worker bundle. Anchored to reality by `satisfies NodeOutputMap[<kind>]` at each interpreter write.
export {
  getNodeOutput,
  type NodeOutputMap,
  type NodeOutput,
} from "./node-output";
