import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import {
  CONDITION_OPS,
  NODE_TYPES,
  nodeCatalogPrompt,
  validateGraph,
} from "@naary/dsl";
import { CredentialsService, MissingCredentialError } from "@naary/secrets";
import { APICallError, generateText, jsonSchema, Output } from "ai";

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

// Structured-output schema. Deliberately PERMISSIVE on node `config` (a free object):
// validateGraph is the real gate, and NodeDef.config is itself untyped in the DSL, so
// a strict per-config schema would be stricter than the platform. Uses the AI SDK's
// jsonSchema<T> (not Zod) to avoid the TS2589 generics blow-up in generateText.
const GRAPH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "A short, human title for the workflow.",
    },
    startNodeId: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: NODE_TYPES },
          config: {
            type: "object",
            additionalProperties: true,
            description: "Node-specific config; omit or {} when not needed.",
          },
        },
        required: ["id", "type"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          condition: {
            type: "object",
            properties: {
              path: { type: "string" },
              op: {
                type: "string",
                enum: CONDITION_OPS,
              },
              value: {},
            },
            required: ["path", "op"],
            additionalProperties: false,
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "startNodeId", "nodes", "edges"],
  additionalProperties: false,
} as const;

const graphOutput = jsonSchema<{
  name: string;
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: {
    from: string;
    to: string;
    condition?: { path: string; op: string; value?: unknown };
  }[];
}>(GRAPH_OUTPUT_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]);

const SYSTEM_PROMPT = `You design automation workflows as a JSON graph for a durable workflow engine.

Rules:
- Output a graph: { name, startNodeId, nodes:[{id,type,config?}], edges:[{from,to,condition?}] }.
- Exactly ONE entry node (marked [entry] below) and it MUST be startNodeId.
- Every edge.from/edge.to MUST reference an existing node id. Node ids are short, unique, lowercase.
- Prefer the simplest graph that satisfies the request. End flows with an "end" node (or "respondToWebhook" for a webhook that returns a response).
- Only use connection-based nodes (mcpTool/sqlQuery/sqlExec/sendEmail/hmac/jwt/totp) when the request implies them; leave connectionId as a short placeholder the user will set.
- Do NOT invent node types. Use only the catalog below.
- A conditional edge has condition:{path,op,value}; do NOT put a conditional edge INTO a "merge" node.
- To branch, prefer an "if" (two-way) or "switch" (multi-way) node and put conditions on the edges leaving it (e.g. path:"<if-id>.result", op:"eq", value:true).

Available nodes:
${nodeCatalogPrompt()}`;

@Injectable()
export class GraphGeneratorService {
  constructor(private readonly credentials: CredentialsService) {}

  /**
   * Generate a workflow graph from a natural-language description. The tenant's own
   * provider key is decrypted here (in-request, never persisted/logged) and used for
   * the model call. Returns a DRAFT graph for the canvas to load unsaved — the user
   * edits + saves via POST /graphs, which re-runs validateGraph.
   */
  async generate(
    tenantId: string,
    prompt: string,
    provider?: string,
  ): Promise<{ name: string; graph: GraphDef }> {
    const description = prompt?.trim();
    if (!description)
      throw new BadRequestException("A description is required");

    const { provider: chosen, apiKey } = await this.resolveProvider(
      tenantId,
      provider,
    );

    // First attempt.
    let out = await this.callModel(chosen, apiKey, description);
    let graph = toGraphDef(out);
    let check = validateGraph(graph);

    // One repair retry: feed the validator error back so the model fixes it.
    if (!check.valid) {
      out = await this.callModel(chosen, apiKey, description, {
        previous: JSON.stringify(out),
        error: check.error ?? "invalid graph",
      });
      graph = toGraphDef(out);
      check = validateGraph(graph);
      if (!check.valid) {
        throw new UnprocessableEntityException(
          `Couldn't generate a valid workflow (${check.error}). Try rephrasing the description.`,
        );
      }
    }

    return { name: out.name?.trim() || "Generated workflow", graph };
  }

  /**
   * Pick the provider to generate with + decrypt its key. If the caller named one, use it;
   * otherwise use the tenant's first configured+valid provider (by preference order). Throws a
   * helpful 400 when the chosen (or any) provider has no usable key.
   */
  private async resolveProvider(
    tenantId: string,
    requested?: string,
  ): Promise<{ provider: GenProvider; apiKey: string }> {
    let provider = requested?.trim() as GenProvider | undefined;
    if (provider && !GEN_PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Unsupported provider: ${requested}`);
    }
    if (!provider) {
      const configured = await this.credentials.listProviders(tenantId);
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
      const apiKey = await this.credentials.getDecryptedKey(tenantId, provider);
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
  ): Promise<{
    name: string;
    startNodeId: string;
    nodes: { id: string; type: string; config?: Record<string, unknown> }[];
    edges: {
      from: string;
      to: string;
      condition?: { path: string; op: string; value?: unknown };
    }[];
  }> {
    const userPrompt = repair
      ? `The previous graph was invalid: ${repair.error}\n\nPrevious graph:\n${repair.previous}\n\nFix it. Original request:\n${description}`
      : description;
    try {
      const result = await generateText({
        model: buildGenModel(provider, apiKey),
        system: SYSTEM_PROMPT,
        prompt: userPrompt,
        output: Output.object({ schema: graphOutput }),
        maxOutputTokens: 4000,
      });
      return result.output;
    } catch (e) {
      throw mapProviderError(e, provider);
    }
  }
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
    if (e.statusCode === 401 || e.statusCode === 403) {
      return new BadRequestException(
        `Your ${provider} API key was rejected. Update it in Integrations.`,
      );
    }
    if (e.statusCode === 429) {
      return new HttpException(
        `${provider} rate limit or quota exceeded. Try again shortly.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
  return new ServiceUnavailableException(
    "The model couldn't generate a workflow right now. Try again.",
  );
}
