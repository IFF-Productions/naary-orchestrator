import { createAnthropic } from "@ai-sdk/anthropic";
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

// The model this feature generates with. Anthropic is the only supported provider
// today (matches the agent activity); the tenant brings their own key.
const GEN_PROVIDER = "anthropic";
const GEN_MODEL = "claude-opus-4-8";

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
  ): Promise<{ name: string; graph: GraphDef }> {
    const description = prompt?.trim();
    if (!description)
      throw new BadRequestException("A description is required");

    const apiKey = await this.getKey(tenantId);

    // First attempt.
    let out = await this.callModel(apiKey, description);
    let graph = toGraphDef(out);
    let check = validateGraph(graph);

    // One repair retry: feed the validator error back so the model fixes it.
    if (!check.valid) {
      out = await this.callModel(apiKey, description, {
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

  private async getKey(tenantId: string): Promise<string> {
    try {
      return await this.credentials.getDecryptedKey(tenantId, GEN_PROVIDER);
    } catch (e) {
      if (e instanceof MissingCredentialError) {
        throw new BadRequestException(
          "Add a valid Anthropic API key in Settings before generating a workflow.",
        );
      }
      throw e;
    }
  }

  private async callModel(
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
        model: createAnthropic({ apiKey })(GEN_MODEL),
        system: SYSTEM_PROMPT,
        prompt: userPrompt,
        output: Output.object({ schema: graphOutput }),
        maxOutputTokens: 4000,
      });
      return result.output;
    } catch (e) {
      throw mapProviderError(e);
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
function mapProviderError(e: unknown): HttpException {
  if (APICallError.isInstance(e)) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      return new BadRequestException(
        "Your Anthropic API key was rejected. Update it in Settings.",
      );
    }
    if (e.statusCode === 429) {
      return new HttpException(
        "Anthropic rate limit or quota exceeded. Try again shortly.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
  return new ServiceUnavailableException(
    "The model couldn't generate a workflow right now. Try again.",
  );
}
