// Leaf node-handler registry (Phase 1 of the run-graph split). Maps a node type →
// its VERBATIM-extracted handler; run-graph.ts's execNodeInner dispatches through this
// before the (now control-flow-only) switch. CONTROL-FLOW node types are intentionally
// ABSENT — merge, executeSubWorkflow, forEach, wait, stopAndError, respondToWebhook,
// humanApproval (and splitOut, intercepted in execChain) stay inline in the switch
// because they touch engine state / return terminal statuses.
import type { NodeDef } from "@naary/dsl";
import type { NodeHandler } from "./contract";
import {
  handlePassthroughNull,
  handleStart,
  handleWebhookTrigger,
  handleScheduleTrigger,
  handleFormTrigger,
  handleChatTrigger,
  handleMcpServerTrigger,
  handleErrorTrigger,
  handleNoOp,
} from "./passthrough";
import {
  handleSet,
  handleRenameKeys,
  handleText,
  handleFilter,
  handleAggregate,
  handleListOps,
  handleCompareDatasets,
  handleSwitch,
  handleIf,
  handleJson,
  handleNumber,
  handleDateTime,
  handleXml,
  handleHtmlExtract,
  handleMarkdown,
  handleCsv,
  handleEncode,
  handleRandom,
} from "./transform";
import { handleHmac, handleHash, handleJwt, handleTotp } from "./crypto";
import {
  handlePollTrigger,
  handleHttpRequest,
  handleGraphQL,
  handleKafkaPublish,
  handleSqlQuery,
  handleSqlExec,
  handleFirestoreQuery,
  handleFirestoreWrite,
  handleRssRead,
  handleVectorUpsert,
  handleVectorQuery,
} from "./data";
import {
  handleAgent,
  handleCodeAgent,
  handleTextToSpeech,
  handleMcpTool,
  handleIntegration,
} from "./ai";
import { handleSendEmail, handleCode } from "./comms";

export const NODE_HANDLERS: Partial<Record<NodeDef["type"], NodeHandler>> = {
  // passthrough / entry nodes
  // `start` publishes the run input as its output, like every other entry node — that is what
  // a sub-workflow's child graph binds to. `end` is the one true no-op.
  start: handleStart,
  end: handlePassthroughNull,
  webhookTrigger: handleWebhookTrigger,
  scheduleTrigger: handleScheduleTrigger,
  formTrigger: handleFormTrigger,
  chatTrigger: handleChatTrigger,
  mcpServerTrigger: handleMcpServerTrigger,
  errorTrigger: handleErrorTrigger,
  noOp: handleNoOp,
  // pure transforms + parser/random/clock nodes
  set: handleSet,
  renameKeys: handleRenameKeys,
  text: handleText,
  filter: handleFilter,
  aggregate: handleAggregate,
  listOps: handleListOps,
  compareDatasets: handleCompareDatasets,
  switch: handleSwitch,
  if: handleIf,
  json: handleJson,
  number: handleNumber,
  dateTime: handleDateTime,
  xml: handleXml,
  htmlExtract: handleHtmlExtract,
  markdown: handleMarkdown,
  csv: handleCsv,
  encode: handleEncode,
  random: handleRandom,
  // crypto
  hmac: handleHmac,
  hash: handleHash,
  jwt: handleJwt,
  totp: handleTotp,
  // data fetch / DB / vector
  pollTrigger: handlePollTrigger,
  httpRequest: handleHttpRequest,
  graphQL: handleGraphQL,
  kafkaPublish: handleKafkaPublish,
  sqlQuery: handleSqlQuery,
  sqlExec: handleSqlExec,
  firestoreQuery: handleFirestoreQuery,
  firestoreWrite: handleFirestoreWrite,
  rssRead: handleRssRead,
  vectorUpsert: handleVectorUpsert,
  vectorQuery: handleVectorQuery,
  // AI / tool / integration
  agent: handleAgent,
  codeAgent: handleCodeAgent,
  textToSpeech: handleTextToSpeech,
  mcpTool: handleMcpTool,
  integration: handleIntegration,
  // comms
  sendEmail: handleSendEmail,
  code: handleCode,
};

export * from "./contract";
