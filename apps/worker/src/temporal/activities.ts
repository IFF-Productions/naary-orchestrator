/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 * This module (and its @naary/secrets / @naary/usage / @naary/db imports) loads
 * in the worker PROCESS, never in the deterministic workflow bundle — workflows.ts
 * imports it type-only.
 *
 * BARREL: the implementations live in ./activities/* domain modules; this file
 * re-exports the exact public surface. Temporal registers activities by these
 * object keys (worker.ts does `import * as activities`) and workflows use
 * `proxyActivities<typeof activities>`, so the exported names here are the
 * contract — keep them stable. Layout:
 *   - activities/shared        — logger, lazy ESM SDK loaders, error sanitization,
 *                                AgentMeta, credential/secret-store helpers
 *   - activities/execution     — run bookkeeping, $vars, chat history, dateTime,
 *                                sub-workflow graph resolution
 *   - activities/signing       — hmac / hash / jwt / totp
 *   - activities/email         — sendEmail (SMTP)
 *   - activities/feeds         — rssRead + pollTrigger
 *   - activities/notifications — tenant notification fan-out (Slack/Teams)
 *   - activities/transforms    — htmlExtract / markdown / random / encode / csv / xml
 *   - activities/code          — QuickJS code node
 *   - activities/agent         — runAgent (AI SDK)
 *   - activities/code-agent    — callCodeAgent (headless coding CLI)
 *   - activities/mcp           — callMcpTool
 *   - activities/http          — callHttpRequest + callGraphQL
 *   - activities/integration   — native integration nodes (GitHub/Jira/…)
 *   - activities/sql           — callSqlQuery / callSqlExec
 *   - activities/map-node      — batched per-item fan-out
 *   - activities/rag           — pgvector vectorUpsert / vectorQuery
 */
// Re-export so the interpreter e2e can reference these as activities.* (the hmac/
// jwt/sendEmail/rss activity args are the DSL's Resolved* types).
export type {
  CodeNodeConfig,
  ResolvedGraphQL,
  ResolvedHash,
  ResolvedHmac,
  ResolvedJwt,
  ResolvedRss,
  ResolvedSendEmail,
} from "@naary/dsl";

export { toSanitizedRetryable } from "./activities/shared";
export type { AgentMeta } from "./activities/shared";

export {
  recordExecution,
  loadVariables,
  setExecutionStatus,
  loadChatHistory,
  appendChatTurn,
  computeDateTime,
  resolveSubWorkflowGraph,
} from "./activities/execution";
export type { DateTimeResult, SubWorkflowGraph } from "./activities/execution";

export {
  __signingDeps,
  callHmac,
  callHash,
  callJwt,
  __totpDeps,
  callTotp,
} from "./activities/signing";
export type {
  HmacResult,
  HashResult,
  JwtResult,
  TotpConfig,
  TotpResult,
} from "./activities/signing";

export { __emailDeps, callSendEmail } from "./activities/email";
export type { SendEmailResult } from "./activities/email";

export {
  __rssDeps,
  callRssRead,
  __pollDeps,
  callPoll,
} from "./activities/feeds";
export type {
  RssItem,
  RssResult,
  PollMeta,
  PollResult,
} from "./activities/feeds";

export {
  __notifyDeps,
  normalizeBaseUrl,
  sendNotification,
} from "./activities/notifications";
export type {
  NotificationKind,
  NotificationInput,
  NotificationChannelRow,
} from "./activities/notifications";

export {
  callHtmlExtract,
  callMarkdown,
  htmlToMarkdown,
  callRandom,
  callEncode,
  callCsv,
  callXml,
} from "./activities/transforms";
export type {
  XmlConfig,
  XmlResult,
  HtmlExtraction,
  HtmlExtractConfig,
  HtmlExtractResult,
  MarkdownResult,
  RandomConfig,
  RandomResult,
  EncodeConfig,
  EncodeResult,
  CsvConfig,
  CsvResult,
} from "./activities/transforms";

export { __codeDeps, callCode } from "./activities/code";
export type { CodeInput, CodeResult } from "./activities/code";

export { __agentDeps, runAgent } from "./activities/agent";
export type { AgentConfig, AgentOutput, AgentResult } from "./activities/agent";

export { __codeAgentDeps, callCodeAgent } from "./activities/code-agent";
export type {
  CodeAgentActivityConfig,
  CodeAgentResult,
} from "./activities/code-agent";

export { __mcpDeps, callMcpTool } from "./activities/mcp";
export type { McpToolConfig, McpToolResult } from "./activities/mcp";

export { __httpDeps, callHttpRequest, callGraphQL } from "./activities/http";
export type {
  HttpRequestConfig,
  HttpRequestResult,
  GraphQLResult,
} from "./activities/http";

export { callIntegration } from "./activities/integration";
export type { IntegrationResult } from "./activities/integration";

export {
  __sqlDeps,
  dsnHost,
  callSqlQuery,
  callSqlExec,
} from "./activities/sql";
export type {
  SqlQueryConfig,
  SqlQueryResult,
  SqlExecConfig,
  SqlExecResult,
} from "./activities/sql";

export { __mapDeps, mapNode } from "./activities/map-node";
export type { MapNodeItem, MapNodeResult } from "./activities/map-node";

export { __ragDeps, callVectorUpsert, callVectorQuery } from "./activities/rag";
export type {
  VectorUpsertResult,
  VectorMatch,
  VectorQueryResult,
} from "./activities/rag";
