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
// #574 wave 2 — the differentiator templates (handoff / RAG / code agent / MCP / budget).
// Own module because templates.ts crossed the 1000-line maintainability gate.
export {
  supervisorHandoffGraph,
  ragAnswerGraph,
  ragIngestGraph,
  codeAgentPrGraph,
  budgetCappedResearchGraph,
  mcpServerToolGraph,
  formToDbGraph,
  escalationGraph,
} from "./templates-advanced";
export {
  bindingNamesSource,
  getByPath,
  isPollutingKey,
  resolveMcpArguments,
} from "./mcp-args";
// `resolveIntegrationFields` names its true home: it is catalog-free and the interpreter calls it
// on every integration node, so it lives in ./integration-fields (#910). Public surface unchanged.
export { resolveIntegrationFields } from "./integration-fields";
export {
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
  getIntegrationProvider,
  getIntegrationAction,
  buildIntegrationRequest,
  validateIntegrationConfig,
  resolveCredentialSetup,
  deriveTokenFormat,
  type IntegrationProvider,
  type IntegrationAction,
  type IntegrationField,
  type BuiltIntegrationRequest,
  type CredentialSetup,
  type ResolvedCredentialSetup,
} from "./integrations";
export {
  planIntegrationCall,
  pickConnectionTestAction,
  resolveIntegrationBaseUrl,
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
// The approval prompt's DISPLAY rendering (#1019) — same resolver, never-blank rule.
export {
  resolvePromptText,
  resolveApprovalPrompt,
  type ApprovalPromptText,
} from "./approval-prompt";
// The agent output CONTRACT (#830 / #1016): an agent promises structured fields only when its
// config carries an `outputSchema`. One definition of "reads a field" / "promises a field",
// shared by the shipped-template drift guard, the canvas lint and the fork migration.
export {
  agentOutputReads,
  promisedAgentFields,
  hasStructuredOutput,
  promptRequestsJson,
  lintAgentOutputContract,
  type AgentOutputRead,
} from "./agent-output-contract";
// #1016 — recognise and correct a graph forked from a template that failed OPEN. Migration is
// deliberately narrow; everything it declines is warned about by `lintAgentOutputContract`.
export {
  FAILING_OPEN_FINGERPRINTS,
  matchFailingOpenFork,
  migrateFailingOpenFork,
  type FailingOpenFingerprint,
  type FailingOpenMigration,
} from "./failing-open-templates";
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
  type McpToolSummary,
  type SqlColumnInfo,
  type SqlTableInfo,
  type SqlSchemaSummary,
} from "./introspection";
export {
  resolveSqlQuery,
  type ResolvedSqlQuery,
  resolveSqlExec,
  type ResolvedSqlExec,
} from "./sql-query";
export {
  resolveFirestoreQuery,
  type ResolvedFirestoreQuery,
  resolveFirestoreWrite,
  type ResolvedFirestoreWrite,
} from "./firestore";
export {
  evaluateResume,
  resumeWarningText,
  type ResumeEligibility,
  type ResumeEligibilityInput,
  type ResumeRefusal,
  type ResumeWarning,
} from "./resume-eligibility";
export { resolveIf } from "./if-node";
export { resolveJson } from "./json-node";
export { resolveNumber } from "./number-node";
export { resolveSet } from "./set-node";
export { resolveSwitch } from "./switch-node";
export { resolveText } from "./text-node";
export { resolveRenameKeys } from "./rename-keys";
// Rename a node's ID, moving every reference with it (#833) — pure, so it's testable against the
// full enumeration of reference kinds rather than spot-checked on a canvas.
export {
  computeRetryRegions,
  retryBackoffMs,
  unsafeNodeReason,
  type ResolvedRetryPolicy,
  type RetryRegion,
  type RetryRegionResult,
} from "./retry-region";
export {
  referencedNodeIds,
  renameNode,
  type RenameNodeResult,
} from "./rename-node";
export {
  buildFixInstruction,
  type DiagnosisHttpCapture,
  type FixInstruction,
  type FixInstructionInput,
} from "./run-diagnosis";
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
} from "./template-blocks";
// The zod save-gate half, split off so the renderer above stays out of zod's require graph (#926).
// Barrel consumers see no difference; only the module boundary moved.
export {
  templateBlockSchema,
  templateBlocksSchema,
} from "./template-blocks-schema";
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
  type FieldChange,
  type EdgeChange,
} from "./graph-diff";
export {
  NODE_CATALOG,
  NODE_TYPES,
  CONDITION_OPS,
  acceptsSampleInput,
  nodeCatalogPrompt,
  type NodeCatalogEntry,
  type NodeGroup,
} from "./node-catalog";
// Derives a trigger's sample input from its own declaration (#983). Runtime-free, so the canvas
// can import it — see the module header for why the derive happens in the EDITOR, not the service.
export { deriveSampleInput } from "./trigger-sample";
// `evaluateCondition`/`nextNodes` are interpreter hot path; `validateGraph` is a SAVE GATE and the
// only one of the three that needs the integration catalog. They were one module until #910, which
// meant every node transition's `require("./branch")` dragged all 161KB of catalog into the
// deterministic workflow bundle. Split, but re-exported here identically — no caller changed.
export { evaluateCondition, nextNodes } from "./branch";
export { validateGraph, type GraphValidation } from "./validate-graph";
// Which connection types each node accepts. Shared (not web-only) since #830 so the AI generator
// can reject a connection of the WRONG TYPE, not just an unknown id — see the module header.
export {
  CONNECTION_TYPES,
  requiredConnectionTypes,
  type ConnectionType,
} from "./connection-types";
// `./integration-write` (the interpreter's write/read, i.e. at-most-once vs retryable,
// classification) is deliberately NOT re-exported here, for the same reason as ./registry and
// ./n8n-import: the barrel is the authoring-time surface, and this module exists only to keep the
// catalog out of the deterministic workflow bundle. Workflow code reaches it via ./workflow; the
// drift test deep-imports it. Barrel surface is therefore unchanged by #910.
// Agent handoff (#580 Phase 1) — zod-free by design: `validateGraph` imports it, so it
// lands in the deterministic workflow bundle. The agent ACTIVITY imports
// `handoffOutputSchema` from here too, so the save-gate and the runtime schema are the
// same function.
export {
  HANDOFF_TARGET_FIELD,
  handoffConditionPath,
  handoffEdges,
  handoffOutputSchema,
  handoffTargetName,
  readHandoff,
  validateHandoffs,
  type AgentHandoff,
  type HandoffTarget,
} from "./handoff";
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
// Agent guardrails (#576) — the PURE policy layer (zod-free: the tool-policy evaluator is reached
// from deterministic workflow code, the save gate, AND the agent activity). The zod schema for the
// same shape lives in ./registry, which the index deliberately does not re-export.
export {
  EMPTY_GUARDRAIL_POLICY,
  BLOCKED_PLACEHOLDER,
  MAX_CONTENT_RULE_PATTERN_LENGTH,
  MAX_CONTENT_SCAN_CHARS,
  PII_KINDS,
  PII_KIND_VALUES,
  TOOL_BEARING_NODE_TYPES,
  applyContentRules,
  applyContentRulesToValue,
  containsPii,
  violationLabels,
  distinctToolRefs,
  evaluateToolPolicy,
  graphHasToolNodes,
  graphToolRefs,
  integrationToolRef,
  isEmptyGuardrailPolicy,
  matchToolPattern,
  mcpToolRef,
  redactPii,
  validateGraphToolPolicy,
  type AgentGuardrailPolicy,
  type ContentRule,
  type ContentRuleAction,
  type ContentRuleResult,
  type ContentViolation,
  type GraphToolRef,
  type PiiKind,
  type RedactionResult,
  type ToolPolicy,
  type ToolPolicyError,
  type ToolPolicyVerdict,
} from "./guardrails";
