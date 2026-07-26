/**
 * n8n node type → our node type, plus the per-node config translation (#579).
 *
 * This table is the importer's source of truth and is asserted against `NODE_TYPES` in
 * `packages/dsl/test/n8n-import.spec.ts` — deliberately NOT derived from `docs/n8n-node-types.ts`,
 * whose `mapsTo` column is a stale hand-copy that claims `if`, `switch`, `noOp` and
 * `scheduleTrigger` don't exist.
 *
 * Three honesty rules the whole importer hangs off:
 *
 *  - **`imported`** — the mapping is faithful: the node does what it did in n8n.
 *  - **`approximated`** — it will run, but something was lost or reshaped, and the note says what.
 *  - **`unmapped`** — we have no equivalent. The node becomes a `noOp` PLACEHOLDER carrying its
 *    original n8n parameters under `config.__n8n`, so the graph still saves, the topology is intact,
 *    and the configuration is recoverable. Nothing is dropped silently.
 *
 * Why placeholders are safe to carry arbitrary config: `noOp` has no concrete schema (it falls
 * through to the permissive record in registry.ts), and the save path persists the ORIGINAL graph
 * bytes rather than a zod-parsed copy — so `__n8n` survives a round-trip verbatim.
 */
import type { NodeType } from "./types/core";

/** Fidelity of one node's translation. `skipped` = intentionally not a graph node at all. */
export type N8nMapStatus = "imported" | "approximated" | "unmapped" | "skipped";

export interface N8nMapping {
  /**
   * Our node type, or null when this table has none to name. `null` does NOT mean "absent from
   * the graph" — read it together with `status`:
   *   · `skipped`  → genuinely not a graph node (annotations, sub-nodes folded into a parent);
   *   · `unmapped` → still becomes a node, a `noOp` PLACEHOLDER the importer substitutes, with
   *                  the original n8n config preserved under `config.__n8n` so it can be rebuilt.
   * The split-and-loop constructs are the second kind, so treating `null` as "not represented"
   * would under-count the nodes an import actually produces.
   */
  nodeType: NodeType | null;
  status: N8nMapStatus;
  /** Fixed config merged under the translated parameters (e.g. `{ operation: "parse" }`). */
  baseConfig?: Record<string, unknown>;
  /** Note appended to this node's report entry — required for anything not `imported`. */
  note?: string;
}

/**
 * n8n node types that are **sub-nodes**: they are wired to a parent over a non-`main` connection
 * (`ai_languageModel`, `ai_tool`, `ai_memory`, …) and are configuration OF that parent, not steps in
 * the flow. They must never become graph nodes or edges — the importer folds what it can into the
 * parent `agent` node and reports the rest.
 */
export const N8N_SUB_NODE_TYPES: ReadonlySet<string> = new Set([
  "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  "@n8n/n8n-nodes-langchain.lmChatAnthropic",
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
  "@n8n/n8n-nodes-langchain.lmChatOllama",
  "@n8n/n8n-nodes-langchain.lmOpenAi",
  "@n8n/n8n-nodes-langchain.memoryBufferWindow",
  "@n8n/n8n-nodes-langchain.memoryPostgresChat",
  "@n8n/n8n-nodes-langchain.outputParserStructured",
  "@n8n/n8n-nodes-langchain.toolWorkflow",
  "@n8n/n8n-nodes-langchain.toolHttpRequest",
  "@n8n/n8n-nodes-langchain.toolCode",
  "@n8n/n8n-nodes-langchain.toolCalculator",
  "@n8n/n8n-nodes-langchain.embeddingsOpenAi",
  "@n8n/n8n-nodes-langchain.vectorStoreInMemory",
  "@n8n/n8n-nodes-langchain.vectorStorePGVector",
]);

/** n8n's LLM sub-node type → our `agent.provider`. */
export const N8N_LM_PROVIDER: Record<string, string> = {
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": "openai",
  "@n8n/n8n-nodes-langchain.lmOpenAi": "openai",
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": "anthropic",
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": "google",
};

/**
 * n8n app nodes that correspond to a provider in OUR integration catalog. Mapped to an
 * `integration` node with the provider pre-set but **no action and no connectionId** — the action
 * vocabularies don't line up 1:1, so choosing one silently would be a guess. The save gate is
 * lenient on missing fields, so this saves as a draft; the report says what's left to pick.
 */
export const N8N_APP_TO_PROVIDER: Record<string, string> = {
  "n8n-nodes-base.github": "github",
  "n8n-nodes-base.githubTrigger": "github",
  "n8n-nodes-base.jira": "jira",
  "n8n-nodes-base.slack": "slack",
  "n8n-nodes-base.notion": "notion",
  "n8n-nodes-base.airtable": "airtable",
  "n8n-nodes-base.asana": "asana",
  "n8n-nodes-base.clickUp": "clickup",
  "n8n-nodes-base.discord": "discord",
  "n8n-nodes-base.dropbox": "dropbox",
  "n8n-nodes-base.gitlab": "gitlab",
  "n8n-nodes-base.googleSheets": "googlesheets",
  "n8n-nodes-base.hubspot": "hubspot",
  "n8n-nodes-base.intercom": "intercom",
  "n8n-nodes-base.linear": "linear",
  "n8n-nodes-base.mailchimp": "mailchimp",
  "n8n-nodes-base.mattermost": "mattermost",
  "n8n-nodes-base.mondayCom": "monday",
  "n8n-nodes-base.microsoftOutlook": "msgraph",
  "n8n-nodes-base.pagerDuty": "pagerduty",
  "n8n-nodes-base.pipedrive": "pipedrive",
  "n8n-nodes-base.sendGrid": "sendgrid",
  "n8n-nodes-base.sentryIo": "sentry",
  "n8n-nodes-base.shopify": "shopify",
  "n8n-nodes-base.stripe": "stripe",
  "n8n-nodes-base.todoist": "todoist",
  "n8n-nodes-base.twilio": "twilio",
  "n8n-nodes-base.vercel": "vercel",
  "n8n-nodes-base.webflow": "webflow",
  "n8n-nodes-base.zendesk": "zendesk",
  "n8n-nodes-base.zoom": "zoom",
  "n8n-nodes-base.box": "box",
  "n8n-nodes-base.calendly": "calendly",
  "n8n-nodes-base.cloudflare": "cloudflare",
  "n8n-nodes-base.deepL": "deepl",
  "n8n-nodes-base.digitalOcean": "digitalocean",
  "n8n-nodes-base.front": "front",
  "n8n-nodes-base.netlify": "netlify",
  "n8n-nodes-base.posthog": "posthog",
};

/**
 * The core mapping table. Keys are n8n `type` strings exactly as they appear in an export.
 *
 * Deliberate `unmapped` decisions worth stating out loud (they look like gaps and are choices):
 *  - **Split Out / Loop Over Items.** We *have* `splitOut`/`loopEnd`, but a region may only contain
 *    pure nodes plus agent/httpRequest/mcpTool (`computeItemsRegions`), so an n8n loop body with a
 *    Send Email, Code or database write inside it would be REJECTED at save. Emitting a bracket we
 *    can't close is worse than a placeholder that saves and tells the truth.
 *  - **Execute Workflow.** `executeSubWorkflow` needs OUR `workflowKey`; n8n references a workflow
 *    by its own id, which means nothing here.
 */
export const N8N_NODE_MAP: Record<string, N8nMapping> = {
  // ── Triggers ────────────────────────────────────────────────────────────────────────────────
  "n8n-nodes-base.webhook": { nodeType: "webhookTrigger", status: "imported" },
  "n8n-nodes-base.manualTrigger": { nodeType: "start", status: "imported" },
  "n8n-nodes-base.executeWorkflowTrigger": {
    nodeType: "start",
    status: "approximated",
    note: "n8n's 'When executed by another workflow' becomes a plain start node — call it as a sub-workflow from the parent instead.",
  },
  "n8n-nodes-base.scheduleTrigger": {
    nodeType: "scheduleTrigger",
    status: "imported",
  },
  "n8n-nodes-base.cron": { nodeType: "scheduleTrigger", status: "imported" },
  "n8n-nodes-base.intervalTrigger": {
    nodeType: "scheduleTrigger",
    status: "approximated",
    note: "an interval becomes a cron expression — check the schedule before activating.",
  },
  "n8n-nodes-base.errorTrigger": {
    nodeType: "errorTrigger",
    status: "imported",
  },
  "n8n-nodes-base.formTrigger": { nodeType: "formTrigger", status: "imported" },
  "n8n-nodes-base.n8nTrigger": {
    nodeType: "start",
    status: "approximated",
    note: "n8n instance lifecycle triggers have no equivalent — imported as a manual start.",
  },
  "@n8n/n8n-nodes-langchain.chatTrigger": {
    nodeType: "chatTrigger",
    status: "imported",
  },
  "n8n-nodes-base.rssFeedReadTrigger": {
    nodeType: "pollTrigger",
    status: "approximated",
    note: "becomes a pollTrigger against the feed URL — set the poll interval.",
  },

  // ── HTTP / data sources ─────────────────────────────────────────────────────────────────────
  "n8n-nodes-base.httpRequest": { nodeType: "httpRequest", status: "imported" },
  "n8n-nodes-base.graphql": { nodeType: "graphQL", status: "imported" },
  "n8n-nodes-base.rssFeedRead": { nodeType: "rssRead", status: "imported" },
  "n8n-nodes-base.postgres": {
    nodeType: "sqlQuery",
    status: "approximated",
    note: "imported as a read-only sqlQuery; if the original wrote, switch it to sqlExec. Needs a database connection.",
  },
  "n8n-nodes-base.mySql": {
    nodeType: "sqlQuery",
    status: "approximated",
    note: "imported as a read-only sqlQuery; if the original wrote, switch it to sqlExec. Needs a database connection.",
  },
  "n8n-nodes-base.microsoftSql": {
    nodeType: "sqlQuery",
    status: "approximated",
    note: "imported as a read-only sqlQuery; if the original wrote, switch it to sqlExec. Needs a database connection.",
  },

  // ── Transform ───────────────────────────────────────────────────────────────────────────────
  "n8n-nodes-base.set": { nodeType: "set", status: "imported" },
  "n8n-nodes-base.code": { nodeType: "code", status: "imported" },
  "n8n-nodes-base.function": {
    nodeType: "code",
    status: "approximated",
    note: "the legacy Function node's `items` API differs from our code node's ($input / $ctx) — review the body.",
  },
  "n8n-nodes-base.functionItem": {
    nodeType: "code",
    status: "approximated",
    note: "the legacy Function Item node ran per item; our code node runs once over the whole input — review the body.",
  },
  "n8n-nodes-base.filter": { nodeType: "filter", status: "imported" },
  "n8n-nodes-base.aggregate": { nodeType: "aggregate", status: "imported" },
  "n8n-nodes-base.sort": {
    nodeType: "listOps",
    status: "approximated",
    baseConfig: { operation: "sort" },
    note: "sort key/direction are not translated — set them on the listOps node.",
  },
  "n8n-nodes-base.limit": {
    nodeType: "listOps",
    status: "approximated",
    baseConfig: { operation: "limit" },
    note: "check the limit count on the listOps node.",
  },
  "n8n-nodes-base.removeDuplicates": {
    nodeType: "listOps",
    status: "approximated",
    baseConfig: { operation: "dedupe" },
    note: "dedupe key is not translated — set it on the listOps node.",
  },
  "n8n-nodes-base.renameKeys": { nodeType: "renameKeys", status: "imported" },
  "n8n-nodes-base.dateTime": {
    nodeType: "dateTime",
    status: "approximated",
    note: "n8n's date operations are richer than ours — check the result.",
  },
  "n8n-nodes-base.html": {
    nodeType: "htmlExtract",
    status: "approximated",
    note: "CSS extractions are not translated — re-declare them on the htmlExtract node.",
  },
  "n8n-nodes-base.markdown": { nodeType: "markdown", status: "imported" },
  "n8n-nodes-base.xml": {
    nodeType: "xml",
    status: "approximated",
    baseConfig: { operation: "parse" },
    note: "defaulted to parse — flip to build if the original serialized XML.",
  },
  "n8n-nodes-base.compareDatasets": {
    nodeType: "compareDatasets",
    status: "approximated",
    note: "the compare key and both inputs need re-binding.",
  },
  "n8n-nodes-base.crypto": {
    nodeType: "hash",
    status: "approximated",
    note: "imported as a keyless hash; for HMAC/JWT use the hmac/jwt nodes with a signing connection.",
  },
  "n8n-nodes-base.convertToFile": {
    nodeType: "csv",
    status: "approximated",
    baseConfig: { operation: "stringify" },
    note: "only CSV is modelled; other file formats need a different node.",
  },
  "n8n-nodes-base.extractFromFile": {
    nodeType: "csv",
    status: "approximated",
    baseConfig: { operation: "parse" },
    note: "only CSV is modelled; other file formats need a different node.",
  },

  // ── Flow control ────────────────────────────────────────────────────────────────────────────
  "n8n-nodes-base.if": { nodeType: "if", status: "imported" },
  "n8n-nodes-base.switch": { nodeType: "switch", status: "imported" },
  "n8n-nodes-base.merge": { nodeType: "merge", status: "imported" },
  "n8n-nodes-base.noOp": { nodeType: "noOp", status: "imported" },
  "n8n-nodes-base.wait": { nodeType: "wait", status: "imported" },
  "n8n-nodes-base.stopAndError": {
    nodeType: "stopAndError",
    status: "imported",
  },
  "n8n-nodes-base.respondToWebhook": {
    nodeType: "respondToWebhook",
    status: "imported",
  },
  "n8n-nodes-base.splitInBatches": {
    nodeType: null,
    status: "unmapped",
    note: "Loop Over Items has no direct equivalent: our splitOut…loopEnd region may only contain pure nodes plus agent/httpRequest/mcpTool, so most n8n loop bodies cannot be expressed. Use a forEach node calling a sub-workflow, or splitOut…loopEnd if the body is pure.",
  },
  "n8n-nodes-base.splitOut": {
    nodeType: null,
    status: "unmapped",
    note: "Split Out opens a per-item region here (splitOut…loopEnd) whose body is restricted to pure nodes plus agent/httpRequest/mcpTool — draw the region by hand so the bracket is valid.",
  },
  "n8n-nodes-base.itemLists": {
    nodeType: null,
    status: "unmapped",
    note: "the legacy Item Lists node covers several operations (split out / aggregate / sort / limit); pick the matching node (splitOut / aggregate / listOps) by hand.",
  },
  "n8n-nodes-base.executeWorkflow": {
    nodeType: null,
    status: "unmapped",
    note: "executeSubWorkflow needs one of OUR workflow keys; n8n references its own workflow id, which does not exist here. Point it at the imported sub-workflow after you import that too.",
  },
  "n8n-nodes-base.stickyNote": {
    nodeType: null,
    status: "skipped",
    note: "a canvas annotation, not a step — nothing to run, so it is not part of the graph.",
  },

  // ── AI ──────────────────────────────────────────────────────────────────────────────────────
  "@n8n/n8n-nodes-langchain.agent": { nodeType: "agent", status: "imported" },
  "@n8n/n8n-nodes-langchain.chainLlm": {
    nodeType: "agent",
    status: "approximated",
    note: "a Basic LLM Chain becomes an agent with no tools.",
  },
  "@n8n/n8n-nodes-langchain.openAi": {
    nodeType: "agent",
    status: "approximated",
    baseConfig: { provider: "openai" },
    note: "an OpenAI node becomes an agent — set the model.",
  },
  "@n8n/n8n-nodes-langchain.chainSummarization": {
    nodeType: "agent",
    status: "approximated",
    note: "a summarization chain becomes a plain agent — put the summarize instruction in the system prompt.",
  },
  "@n8n/n8n-nodes-langchain.mcpClientTool": {
    nodeType: "mcpTool",
    status: "approximated",
    note: "needs an MCP connection and a tool name.",
  },

  // ── Comms ───────────────────────────────────────────────────────────────────────────────────
  "n8n-nodes-base.emailSend": {
    nodeType: "sendEmail",
    status: "approximated",
    note: "needs an SMTP connection — credentials are never imported.",
  },
  "n8n-nodes-base.gmail": {
    nodeType: "sendEmail",
    status: "approximated",
    note: "imported as SMTP send; connect an SMTP server (we have no Gmail API node).",
  },
};

/** Lookup that tolerates the version suffix some exports carry (`…webhook` vs `…webhook.v2`). */
export function lookupN8nNode(type: string): N8nMapping | undefined {
  if (Object.prototype.hasOwnProperty.call(N8N_NODE_MAP, type)) {
    return N8N_NODE_MAP[type];
  }
  const stripped = type.replace(/\.v\d+$/, "");
  return Object.prototype.hasOwnProperty.call(N8N_NODE_MAP, stripped)
    ? N8N_NODE_MAP[stripped]
    : undefined;
}

/** n8n credential type → the connection type a user should create here. Null = no equivalent. */
export const N8N_CREDENTIAL_HINT: Record<string, string | null> = {
  httpHeaderAuth: "custom",
  httpBasicAuth: "custom",
  httpQueryAuth: null,
  httpBearerAuth: "custom",
  oAuth2Api: "custom",
  githubApi: "github",
  githubOAuth2Api: "github",
  jiraSoftwareCloudApi: "atlassian",
  slackApi: "custom",
  slackOAuth2Api: "custom",
  smtp: "smtp",
  postgres: "postgres",
  mySql: "mysql",
  microsoftSql: "mssql",
  openAiApi: null,
  anthropicApi: null,
  googlePalmApi: null,
  notionApi: "custom",
  airtableTokenApi: "custom",
};
