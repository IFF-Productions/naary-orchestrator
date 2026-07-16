import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import {
  CONDITION_OPS,
  INTEGRATION_PROVIDERS,
  NODE_TYPES,
  nodeCatalogPrompt,
  validateGraph,
} from "@naary/dsl";
import { ConnectionService } from "@naary/connections";
import { CredentialsService, MissingCredentialError } from "@naary/secrets";
import { APICallError, generateText } from "ai";

// Providers the generator can use, in preference order — when the caller doesn't pick one,
// the first provider the tenant has a valid key for wins. Kept in sync with the worker's
// buildModel() + MODEL_PRICING. The tenant brings their own key (BYOK).
const GEN_PROVIDERS = ["anthropic", "openai", "google"] as const;
type GenProvider = (typeof GEN_PROVIDERS)[number];
const GEN_DEFAULT_MODEL: Record<GenProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4.1",
  google: "gemini-2.5-pro",
};

/** Build the AI SDK model handle for a provider (mirrors the worker's buildModel). */
function buildGenModel(provider: GenProvider, apiKey: string) {
  const model = GEN_DEFAULT_MODEL[provider];
  if (provider === "openai") return createOpenAI({ apiKey })(model);
  if (provider === "google") return createGoogleGenerativeAI({ apiKey })(model);
  return createAnthropic({ apiKey })(model);
}

// The node types + operators the generator may use come from the shared @naary/dsl catalog
// (NODE_TYPES / CONDITION_OPS), so adding a node/operator automatically teaches the AI builder
// about it — no more hand-maintained list drifting behind the DSL (the old bug).

// NOTE: we generate as plain-text JSON (parsed + validated below), NOT AI-SDK structured
// output. Structured output (`Output.object`) returned a skeleton here — nodes with id+type
// but empty edges and empty config, even on repair — so free-form generation driven by the
// prompt (few-shot + fill rules) produces materially better graphs. validateGraph + the
// node-type/connectivity checks + one repair retry are the real gate.

const SYSTEM_PROMPT = `You design automation workflows as a JSON graph for a durable workflow engine.

Rules:
- Output a graph: { name, startNodeId, nodes:[{id,type,config?}], edges:[{from,to,condition?}] }.
- Exactly ONE entry node (marked [entry] below) and it MUST be startNodeId.
- Every edge.from/edge.to MUST reference an existing node id. Node ids are short, unique, lowercase.
- Prefer the simplest graph that satisfies the request. End flows with an "end" node (or "respondToWebhook" for a webhook that returns a response).
- Only use connection-based nodes (mcpTool/sqlQuery/sqlExec/sendEmail/hmac/jwt/totp) when the request implies them; leave connectionId as a short placeholder the user will set.
- Do NOT invent node types. Use only the catalog below.
- FILL IN each node's config with concrete, ready-to-run values inferred from the request, following the "config:" shape shown for that node type below. Write real agent systemPrompts (specific to the task), real url+method for httpRequest, real title+instructions for humanApproval, real subject+body for sendEmail, etc. Reference upstream outputs with {{ nodeId.path }} where a value comes from an earlier node.
- Do NOT emit an empty config {} for a node whose catalog entry shows config keys. Only nodes with no "config:" shape (e.g. start, end, merge) may omit config. For connection-based nodes leave ONLY connectionId as a "<...>" placeholder; still fill the rest.
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

@Injectable()
export class GraphGeneratorService {
  private readonly logger = new Logger(GraphGeneratorService.name);
  constructor(
    private readonly credentials: CredentialsService,
    private readonly connections: ConnectionService,
  ) {}

  /**
   * Ground the model in the tenant's ACTUAL resources so it doesn't invent connectionIds or
   * unsupported provider actions (the #1 causes of AI-generated workflows failing at run time):
   * the real connections (with their exact ids), and the integration catalog's provider→action
   * list with required fields. Per-request + env-scoped (connections belong to a specific env, so
   * generation is grounded in the ACTIVE env's connections — Slice 5).
   */
  private async buildResourceContext(
    tenantId: string,
    environmentId: string,
  ): Promise<string> {
    const conns = await this.connections
      .list(tenantId, environmentId)
      .catch(() => []);
    const lines: string[] = [];
    if (conns.length > 0) {
      lines.push(
        "AVAILABLE CONNECTIONS — for any node that needs a connectionId, use ONE of these EXACT id values. NEVER invent a connectionId. If none fits, leave connectionId empty:",
        ...conns.map(
          (c) =>
            `- id="${c.id}"  type=${c.type}${c.label ? `  (${c.label})` : ""}`,
        ),
      );
    } else {
      lines.push(
        "NO CONNECTIONS are configured. Do NOT add nodes that require a connectionId (integration, mcpTool, sqlQuery, sqlExec, sendEmail); if you must, leave connectionId empty so the user fills it.",
      );
    }
    lines.push(
      "",
      "INTEGRATION node actions (set config.provider + config.action to one of these; fill the required fields via fields/fieldBindings). There is NO action beyond these — do not invent one (e.g. there is no 'push commit'):",
    );
    for (const p of INTEGRATION_PROVIDERS) {
      for (const a of p.actions) {
        const req = a.fields
          .filter((f) => f.required)
          .map((f) => f.key)
          .join(", ");
        lines.push(
          `- provider="${p.key}" action="${a.key}"${req ? `  required: ${req}` : ""}`,
        );
      }
    }
    return lines.join("\n") + "\n\n";
  }

  /**
   * Generate a workflow graph from a natural-language description. The tenant's own
   * provider key is decrypted here (in-request, never persisted/logged) and used for
   * the model call. Returns a DRAFT graph for the canvas to load unsaved — the user
   * edits + saves via POST /graphs, which re-runs validateGraph.
   */
  async generate(
    tenantId: string,
    environmentId: string,
    prompt: string,
    provider?: string,
  ): Promise<{ name: string; graph: GraphDef }> {
    const description = prompt?.trim();
    if (!description)
      throw new BadRequestException("A description is required");

    // Env-scoped (Slice 5): use THIS env's provider key + connections to ground generation.
    const { provider: chosen, apiKey } = await this.resolveProvider(
      tenantId,
      environmentId,
      provider,
    );

    // Ground the model in this env's real connections + the integration action catalog.
    const resources = await this.buildResourceContext(tenantId, environmentId);

    // First attempt.
    let out = await this.callModel(
      chosen,
      apiKey,
      description,
      undefined,
      resources,
    );
    this.logDraftShape("first", out);
    let graph = toGraphDef(out);
    let check = this.validate(graph);

    // One repair retry: feed the validator error back so the model fixes it.
    if (!check.valid) {
      out = await this.callModel(
        chosen,
        apiKey,
        description,
        {
          previous: JSON.stringify(out),
          error: check.error ?? "invalid graph",
        },
        resources,
      );
      this.logDraftShape(`repair(${check.error})`, out);
      graph = toGraphDef(out);
      check = this.validate(graph);
      if (!check.valid) {
        throw new UnprocessableEntityException(
          `Couldn't generate a valid workflow (${check.error}). Try rephrasing the description.`,
        );
      }
    }

    return { name: out.name?.trim() || "Generated workflow", graph };
  }

  /** Structural validation + node-type check. Plain-text generation lost the schema's
   *  `type` enum, so guard here that every node type is a real catalog type (feeds the
   *  repair loop when the model invents one). */
  private validate(graph: GraphDef): { valid: boolean; error?: string } {
    const structural = validateGraph(graph);
    if (!structural.valid) return structural;
    const unknown = [
      ...new Set(
        graph.nodes
          .map((n) => n.type)
          .filter((t) => !(NODE_TYPES as readonly string[]).includes(t)),
      ),
    ];
    if (unknown.length > 0) {
      return {
        valid: false,
        error: `unknown node type(s): ${unknown.join(", ")} — use only catalog node types`,
      };
    }
    return { valid: true };
  }

  /** Log the RAW model draft's structure (counts only — node types + per-node config-key
   *  counts + edge count) so we can see what the model actually emitted vs the final graph.
   *  No prompt/completion text, no config values — just shape, safe for our own tenant. */
  private logDraftShape(
    stage: string,
    out: {
      nodes: { type: string; config?: Record<string, unknown> }[];
      edges: unknown[];
    },
  ): void {
    const nodes = out.nodes
      .map((n) => `${n.type}(${n.config ? Object.keys(n.config).length : 0})`)
      .join(",");
    const filled = out.nodes.filter(
      (n) => n.config && Object.keys(n.config).length > 0,
    ).length;
    this.logger.log(
      `draft[${stage}]: nodes=${out.nodes.length} edges=${out.edges.length} filledConfigs=${filled}/${out.nodes.length} [${nodes}]`,
    );
  }

  /**
   * Pick the provider to generate with + decrypt its key. If the caller named one, use it;
   * otherwise use the tenant's first configured+valid provider (by preference order). Throws a
   * helpful 400 when the chosen (or any) provider has no usable key.
   */
  private async resolveProvider(
    tenantId: string,
    environmentId: string,
    requested?: string,
  ): Promise<{ provider: GenProvider; apiKey: string }> {
    let provider = requested?.trim() as GenProvider | undefined;
    if (provider && !GEN_PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Unsupported provider: ${requested}`);
    }
    if (!provider) {
      const configured = await this.credentials.listProviders(
        tenantId,
        environmentId,
      );
      const valid = new Set(
        configured.filter((c) => c.isValid).map((c) => c.provider),
      );
      provider = GEN_PROVIDERS.find((p) => valid.has(p));
      if (!provider) {
        throw new BadRequestException(
          "Add a model provider key (Anthropic, OpenAI, or Google) in Integrations before generating a workflow.",
        );
      }
    }
    try {
      const apiKey = await this.credentials.getDecryptedKey(
        tenantId,
        environmentId,
        provider,
      );
      return { provider, apiKey };
    } catch (e) {
      if (e instanceof MissingCredentialError) {
        throw new BadRequestException(
          `No valid ${provider} key. Add one in Integrations, or choose a provider you've configured.`,
        );
      }
      throw e;
    }
  }

  private async callModel(
    provider: GenProvider,
    apiKey: string,
    description: string,
    repair?: { previous: string; error: string },
    resources = "",
  ): Promise<GraphDraft> {
    const userPrompt = repair
      ? `The previous graph was invalid: ${repair.error}\n\nPrevious graph:\n${repair.previous}\n\nFix it. Original request:\n${description}`
      : description;
    // Plain-text generation (NOT Output.object): the structured-output path returned a
    // skeleton — nodes with id+type but empty edges and empty config, even on repair.
    // Free-form generation follows the prompt (few-shot + fill rules), so the model
    // actually writes edges + config; the JSON is parsed + validated (+ repair) below.
    let text: string;
    try {
      const result = await generateText({
        model: buildGenModel(provider, apiKey),
        system: SYSTEM_PROMPT,
        prompt: `${userPrompt}\n\n${resources}Respond with ONLY the JSON graph object — start at { and end at }. No prose, no markdown code fences.`,
        // Headroom for large multi-branch workflows — a truncated response is unparseable
        // JSON (→ 422). Models used here (opus/gpt-4.1/gemini-2.5-pro) all support this.
        maxOutputTokens: 16000,
      });
      text = result.text;
    } catch (e) {
      // Surface the REAL upstream cause (previously swallowed by the catch-all 503):
      // status/url/message/body — never the API key. This is how we tell a stale model id
      // (404) apart from an overloaded provider (429/529) apart from a network failure.
      this.logger.warn(
        `graph generate failed (provider=${provider}): ${describeProviderError(e)}`,
      );
      throw mapProviderError(e, provider);
    }
    const parsed = parseGraphJson(text);
    if (!parsed) {
      this.logger.warn(
        `graph generate: model returned unparseable JSON (head: ${text.slice(0, 120).replace(/\s+/g, " ")})`,
      );
      throw new UnprocessableEntityException(
        "The model didn't return a valid workflow. Try rephrasing the description.",
      );
    }
    return parsed;
  }
}

/** Draft shape the model returns (loose; validateGraph + toGraphDef do the real checks). */
interface GraphDraft {
  name?: string;
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: {
    from: string;
    to: string;
    condition?: { path: string; op: string; value?: unknown };
  }[];
}

/** Extract a graph object from the model's text: tolerate markdown fences / surrounding
 *  prose by taking the outermost {...}. Returns null if it isn't parseable graph-shaped JSON. */
function parseGraphJson(text: string): GraphDraft | null {
  if (!text) return null;
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as unknown;
    if (
      !obj ||
      typeof obj !== "object" ||
      typeof (obj as GraphDraft).startNodeId !== "string" ||
      !Array.isArray((obj as GraphDraft).nodes) ||
      !Array.isArray((obj as GraphDraft).edges)
    ) {
      return null;
    }
    return obj as GraphDraft;
  } catch {
    return null;
  }
}

/** Safe, key-free one-line summary of a provider error for logs. */
function describeProviderError(e: unknown): string {
  if (APICallError.isInstance(e)) {
    const body =
      typeof e.responseBody === "string" ? e.responseBody.slice(0, 300) : "";
    return `APICallError status=${e.statusCode ?? "?"} url=${e.url ?? "?"} retryable=${e.isRetryable} msg=${e.message} body=${body}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Narrow the loose model output to a GraphDef (validateGraph does deep checks). */
function toGraphDef(out: {
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: {
    from: string;
    to: string;
    condition?: { path: string; op: string; value?: unknown };
  }[];
}): GraphDef {
  return {
    startNodeId: out.startNodeId,
    nodes: out.nodes as GraphDef["nodes"],
    edges: out.edges as GraphDef["edges"],
  };
}

/** Map provider failures to HTTP responses (mirrors the worker's AUTH/QUOTA split). */
function mapProviderError(e: unknown, provider: string): HttpException {
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    if (status === 401 || status === 403) {
      return new BadRequestException(
        `Your ${provider} API key was rejected. Update it in Integrations.`,
      );
    }
    // Model renamed/removed → a 404 (or a 400 "model not found"). Actionable, not a
    // generic 503: the fix is to update the generator's model id, not "try again".
    if (
      status === 404 ||
      (status === 400 && /model/i.test(e.responseBody ?? ""))
    ) {
      return new UnprocessableEntityException(
        `The ${provider} model "${GEN_DEFAULT_MODEL[provider as GenProvider] ?? "?"}" is unavailable (it may have been renamed). Update the generator model id.`,
      );
    }
    // 429 = rate/quota; 529 = Anthropic "overloaded"; other 5xx = provider down.
    if (status === 429 || status === 529) {
      return new HttpException(
        `${provider} is rate-limited or overloaded. Try again shortly.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (typeof status === "number" && status >= 500) {
      return new ServiceUnavailableException(
        `${provider} is temporarily unavailable (upstream ${status}). Try again shortly.`,
      );
    }
  }
  return new ServiceUnavailableException(
    "The model couldn't generate a workflow right now. Try again.",
  );
}
