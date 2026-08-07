import { CONDITION_OPS, nodeCatalogPrompt } from "@naary/dsl";

/** Per-element hooks the streaming path fires as the free-form graph is parsed live. */
export interface StreamHooks {
  onMeta?: (name: string) => void;
  onNode?: (node: unknown) => void;
  onEdge?: (edge: unknown) => void;
}

// Providers the generator can use, in preference order — when the caller doesn't pick one,
// the first provider the tenant has a valid key for wins. Kept in sync with the worker's
// buildModel() + MODEL_PRICING. The tenant brings their own key (BYOK).
export const GEN_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type GenProvider = (typeof GEN_PROVIDERS)[number];
export const GEN_DEFAULT_MODEL: Record<GenProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4.1",
  google: "gemini-2.5-pro",
};

/** Raw token counts a model call reported, normalized. `null` when the provider gave none
 *  (the claude-code subprocess always; the AI-SDK v6 usage-undefined bug sometimes) — the
 *  caller then ESTIMATES rather than recording zero (Tier-1 §6 billing fail-safe). */
export interface GenTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Per-turn meter for a metered generate/edit (the conversational builder). `provider`/`model`
 *  are ALWAYS a real PRICED pair (claude-code maps to anthropic/opus) so a cost can be computed
 *  even from an estimate; `tokens` is null when the provider reported no usage. */
export interface GenMeter {
  provider: GenProvider;
  model: string;
  tokens: GenTokens | null;
}

/** Normalize an AI-SDK usage object (v6 `inputTokens`/`outputTokens`, older
 *  `promptTokens`/`completionTokens`) → GenTokens, or null when it's absent/empty (the v6
 *  usage-undefined bug). Never throws — a metering read must not break a successful call. */
export function readGenTokens(raw: unknown): GenTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, number | undefined>;
  const inputTokens = u.inputTokens ?? u.promptTokens;
  const outputTokens = u.outputTokens ?? u.completionTokens;
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number")
    return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens: u.cachedInputTokens ?? 0,
  };
}

/**
 * The Claude Code credential (its own BYOK slot since #296 — can be a subscription
 * setup-token, not just an API key) can ALSO power the builder: generation then runs
 * through the headless `claude -p` CLI instead of the Anthropic API, so it bills to the
 * tenant's Claude subscription. API-model providers are still preferred when configured
 * (faster, no subprocess); this is the fallback that makes a claude-code-only tenant work.
 */
export const CLAUDE_CODE = "claude-code" as const;
export type GenSource = GenProvider | typeof CLAUDE_CODE;

/** Default subprocess ceiling (legacy JSON route): nginx proxies /api with its default 60s
 *  read timeout, so that route's CLI call must give up (with a clear error) before the proxy
 *  would turn the reply into a 504. The SSE route (POST /graphs/generate/stream) heartbeats
 *  past the proxy timeout and passes its own, much larger ceiling via generate() opts. */
export const CLAUDE_CODE_TIMEOUT_MS = 55_000;

/** Exactly ONE auth env var for the CLI — a subscription setup-token (sk-ant-oat…) via
 *  CLAUDE_CODE_OAUTH_TOKEN, a plain API key via ANTHROPIC_API_KEY. Mirrors the worker's
 *  codeAgent driver `authEnv` (apps/worker/src/temporal/code-agent-drivers.ts). */
export function claudeCodeAuthEnv(key: string): Record<string, string> {
  const k = key.trim();
  return k.startsWith("sk-ant-oat")
    ? { CLAUDE_CODE_OAUTH_TOKEN: k }
    : { ANTHROPIC_API_KEY: k };
}

// The node types + operators the generator may use come from the shared @naary/dsl catalog
// (NODE_TYPES / CONDITION_OPS), so adding a node/operator automatically teaches the AI builder
// about it — no more hand-maintained list drifting behind the DSL (the old bug).

// NOTE: we generate as plain-text JSON (parsed + validated below), NOT AI-SDK structured
// output. Structured output (`Output.object`) returned a skeleton here — nodes with id+type
// but empty edges and empty config, even on repair — so free-form generation driven by the
// prompt (few-shot + fill rules) produces materially better graphs. validateGraph + the
// node-type/connectivity checks + one repair retry are the real gate.

export const SYSTEM_PROMPT = `You design automation workflows as a JSON graph for a durable workflow engine.

Rules:
- Output a graph: { name, startNodeId, nodes:[{id,type,config?}], edges:[{from,to,condition?}] }.
- Exactly ONE entry node (marked [entry] below) and it MUST be startNodeId.
- Every edge.from/edge.to MUST reference an existing node id. Node ids are short, unique, lowercase.
- Prefer the simplest graph that satisfies the request. End flows with an "end" node (or "respondToWebhook" for a webhook that returns a response).
- Only use connection-based nodes (integration/mcpTool/sqlQuery/sqlExec/sendEmail/hmac/jwt/totp) when the request implies them; leave connectionId as "" unless the resource block below lists a connection that fits.
- NEVER INVENT A VALUE YOU WERE NOT GIVEN. If a field's value is not stated in the request and cannot come from an earlier node, set it to "" — an empty field is reported to the author and they fill it in. Do NOT write a slot like "<your-board-id>" or "<your-twilio-number>": that reads as a real value everywhere, so nothing warns anyone and the first run sends those characters to the provider verbatim.
- Do NOT invent node types. Use only the catalog below.
- FILL IN each node's config with concrete, ready-to-run values inferred from the request, following the "config:" shape shown for that node type below. Write real agent systemPrompts (specific to the task), real url+method for httpRequest, real title+instructions for humanApproval, real subject+body for sendEmail, etc. Reference upstream outputs with {{ nodeId.path }} where a value comes from an earlier node.
- Do NOT emit an empty config {} for a node whose catalog entry shows config keys. Only nodes with no "config:" shape (e.g. start, end, merge) may omit config. Fill every key you can from the request or an upstream node; leave the ones you genuinely can't as "".
- A conditional edge has condition:{path,op,value}; op MUST be one of: ${CONDITION_OPS.join(", ")}. Do NOT put a conditional edge INTO a "merge" node.
- To branch, prefer an "if" (two-way) or "switch" (multi-way) node and put conditions on the edges leaving it (e.g. path:"<if-id>.result", op:"eq", value:true).

Example of the expected quality — note filled configs AND complete edges (a trigger/end takes no config; every other node is ready to run):
{
  "name": "New-lead Slack alert",
  "startNodeId": "hook",
  "nodes": [
    { "id": "hook", "type": "webhookTrigger", "config": {} },
    { "id": "classify", "type": "agent", "config": { "provider": "anthropic", "model": "claude-opus-4-8", "systemPrompt": "You are a sales assistant. Read the incoming lead in {{ hook.body }} and reply with a one-line summary and a priority of 'high' or 'low'." } },
    { "id": "notify", "type": "httpRequest", "config": { "method": "POST", "url": "https://hooks.slack.com/services/<your-webhook>", "body": { "text": "New lead: {{ classify.output }}" } } },
    { "id": "done", "type": "end" }
  ],
  "edges": [
    { "from": "hook", "to": "classify" },
    { "from": "classify", "to": "notify" },
    { "from": "notify", "to": "done" }
  ]
}

Available nodes (each line shows the node's config: shape to fill in):
${nodeCatalogPrompt()}`;
