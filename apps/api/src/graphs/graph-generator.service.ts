// The AI SDK (`ai`, `@ai-sdk/*`) is ESM-only; this file emits CommonJS, so static imports trip
// TS7's ESM/CJS guard. Load lazily via dynamic import() (the sanctioned CJS→ESM path).
const aiSdk = () => import("ai");
const anthropicSdk = () => import("@ai-sdk/anthropic");
const openaiSdk = () => import("@ai-sdk/openai");
const googleSdk = () => import("@ai-sdk/google");
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
  INTEGRATION_PROVIDERS,
  NODE_TYPES,
  validateGraph,
  validateIntegrationConfig,
} from "@naary/dsl";
import { ConnectionService } from "@naary/connections";
import { redactString } from "@naary/observability";
import { CredentialsService, MissingCredentialError } from "@naary/secrets";
import { createGraphStreamExtractor } from "./graph-stream-extractor";
import {
  CLAUDE_CODE,
  CLAUDE_CODE_TIMEOUT_MS,
  claudeCodeAuthEnv,
  GEN_DEFAULT_MODEL,
  GEN_PROVIDERS,
  readGenTokens,
  SYSTEM_PROMPT,
  type GenMeter,
  type GenProvider,
  type GenSource,
  type GenTokens,
  type StreamHooks,
} from "./graph-generator.prompt";
import {
  describeProviderError,
  mapProviderError,
  parseGraphJson,
  toGraphDef,
  type GraphDraft,
} from "./graph-generator.parse";

// Re-export the metering types so existing importers (builder/turn-metering) keep working.
export type { GenMeter, GenTokens } from "./graph-generator.prompt";

/** Build the AI SDK model handle for a provider (mirrors the worker's buildModel). */
async function buildGenModel(provider: GenProvider, apiKey: string) {
  const model = GEN_DEFAULT_MODEL[provider];
  if (provider === "openai")
    return (await openaiSdk()).createOpenAI({ apiKey })(model);
  if (provider === "google")
    return (await googleSdk()).createGoogleGenerativeAI({ apiKey })(model);
  return (await anthropicSdk()).createAnthropic({ apiKey })(model);
}

/** The sandbox-runner endpoint, from the API's own env. Never request-controlled. */
export function sandboxRunnerConfig(): { url: string; token: string } {
  return {
    url: process.env.SANDBOX_RUNNER_URL ?? "",
    token: process.env.SANDBOX_RUNNER_TOKEN ?? "",
  };
}

/** What the runner's `POST /run` gives back (see apps/sandbox-runner). */
export interface SandboxRunOutcome {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

/**
 * Test seam: dispatch a headless CLI run to the sandbox-runner.
 *
 * #680 — this REPLACES the local `execFile("claude", …)`. The API container no longer ships any
 * coding CLI, and it never should have run one in-process: the subprocess inherited the API's cwd
 * (`/app`, the whole source tree), so the read-only tool grant below could read the deployed
 * application's files. It now runs in the runner's EPHEMERAL workspace — an empty directory in an
 * egress-isolated container with a read-only root and no gateway — so there is simply nothing to
 * read. No repo, no git, no diff.
 *
 * `AbortSignal.timeout` is load-bearing: `fetch` has no default timeout in Node, and the old
 * `execFile({ timeout })` was what previously bounded this call. Without it a wedged runner would
 * hang an HTTP request thread indefinitely.
 */
export const __genDeps = {
  runSandbox: async (
    body: Record<string, unknown>,
    opts: { timeoutMs: number },
  ): Promise<SandboxRunOutcome> => {
    const { url, token } = sandboxRunnerConfig();
    const res = await fetch(`${url}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      // Give the runner a little longer than the CLI budget it was handed, so the runner's own
      // (more informative) timeout fires first rather than this one racing it.
      signal: AbortSignal.timeout(opts.timeoutMs + 5_000),
    });
    if (!res.ok) {
      throw new SandboxRunnerError(`runner returned ${res.status}`);
    }
    const parsed = (await res.json()) as SandboxRunOutcome;
    return {
      exitCode: parsed.exitCode ?? 0,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    };
  },
};

/** A failure reaching or using the runner itself (not a failure the CLI reported). Its own class so
 *  the caller can answer 503-with-operator-instructions instead of a generic 500. */
export class SandboxRunnerError extends Error {}

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
  ): Promise<{ text: string; connectionIds: Set<string> }> {
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
        // `const` fields are catalog-supplied (API type discriminators) — the request
        // builder injects them, so never ask the model to fill them.
        const req = a.fields
          .filter((f) => f.required && f.const === undefined)
          .map((f) => f.key)
          .join(", ");
        lines.push(
          `- provider="${p.key}" action="${a.key}"${req ? `  required: ${req}` : ""}`,
        );
      }
    }
    // The ids are returned as well as described: the prompt SAYS "never invent a connectionId",
    // and a prompt is not an enforcement mechanism (see scrubInventedConnections).
    return {
      text: lines.join("\n") + "\n\n",
      connectionIds: new Set(conns.map((c) => c.id)),
    };
  }

  /**
   * Blank every `connectionId` the model invented.
   *
   * Reported as "build with AI … auto populated bogus connections". The resource block tells the
   * model to use one of the tenant's EXACT ids and never to invent one — but nothing checked, and
   * `validate()` only covers structure and node types. An invented id is the worst possible
   * outcome: the node LOOKS configured, passes the save gate, and fails at run time with "unknown
   * connection" — long after the author stopped looking.
   *
   * Blanked rather than dropped, because empty is the state the rest of the product already
   * understands: the canvas lints it, the save gate reports it, and the config panel shows an empty
   * picker. The author is told to choose, which is exactly what the model couldn't do for them.
   *
   * Returns the ids it removed so the caller can log them (never the graph, never config values).
   */
  private scrubInventedConnections(
    graph: GraphDef,
    real: Set<string>,
  ): string[] {
    const removed: string[] = [];
    for (const node of graph.nodes) {
      const cfg = node.config as { connectionId?: unknown } | undefined;
      const id = cfg?.connectionId;
      if (typeof id !== "string" || id === "") continue;
      if (real.has(id)) continue;
      // The NODE ID, not the node type: the id is what the author sees on the canvas and what the
      // issues panel names, so a log line points at the thing they can actually click.
      removed.push(`${node.id}:${id}`);
      (cfg as { connectionId?: string }).connectionId = "";
    }
    return removed;
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
    opts?: { timeoutMs?: number },
  ): Promise<{ name: string; graph: GraphDef }> {
    return this.generateInternal(
      tenantId,
      environmentId,
      prompt,
      provider,
      opts,
    );
  }

  /**
   * Streaming variant of {@link generate}: identical prompt/quality/validation, but for
   * the API-model providers (anthropic/openai/google) it uses the AI SDK `streamText` and
   * surfaces each complete node/edge to the caller's hooks the moment it's parsed out of
   * the accumulating text — so the canvas can draw the workflow live. The `claude-code`
   * subprocess path CAN'T stream token-by-token, so it just produces the final graph (no
   * per-element hooks); the caller still gets the authoritative graph either way.
   *
   * The final returned graph is always the validated (+ one-shot repaired) graph — the
   * client reconciles its live canvas to it. Hooks fire only for the FIRST draft; a repair
   * pass (rare, non-streaming) does not re-emit.
   */
  async generateStream(
    tenantId: string,
    environmentId: string,
    prompt: string,
    provider?: string,
    opts?: {
      timeoutMs?: number;
      onMeta?: (name: string) => void;
      onNode?: (node: unknown) => void;
      onEdge?: (edge: unknown) => void;
    },
  ): Promise<{ name: string; graph: GraphDef }> {
    return this.generateInternal(
      tenantId,
      environmentId,
      prompt,
      provider,
      opts,
    );
  }

  /**
   * Conversational builder (AI-BUILDER-CONVERSATION.md §2): apply a natural-language change to a
   * draft and stream the FULL updated graph — the metered generate/edit the builder uses. Same
   * SYSTEM_PROMPT / resource grounding / validate-then-repair / SSE hooks as {@link generateStream},
   * with two differences: (1) when `previous` is set the user prompt frames it as an EDIT ("here's
   * the current graph, apply this change, return the whole graph") — NOT the repair prompt, which
   * says the graph was *invalid*; with no `previous` (the first turn on a blank session) it's a
   * plain create. (2) it returns a {@link GenMeter} so the caller can bill the turn (Tier-1 §6).
   *
   * PRIVACY (Tier-1 §4): the instruction is the user's own content — like the create path, this
   * logs only draft SHAPE (counts) and redacted provider errors, never the instruction text.
   */
  async editStream(
    tenantId: string,
    environmentId: string,
    edit: { previous?: GraphDef; instruction: string },
    provider?: string,
    opts?: {
      timeoutMs?: number;
      onMeta?: (name: string) => void;
      onNode?: (node: unknown) => void;
      onEdge?: (edge: unknown) => void;
    },
  ): Promise<{ name: string; graph: GraphDef; meter: GenMeter }> {
    const instruction = edit.instruction?.trim();
    if (!instruction)
      throw new BadRequestException("A change description is required");
    const timeoutMs = opts?.timeoutMs ?? CLAUDE_CODE_TIMEOUT_MS;
    const hooks =
      opts?.onMeta || opts?.onNode || opts?.onEdge
        ? { onMeta: opts.onMeta, onNode: opts.onNode, onEdge: opts.onEdge }
        : undefined;

    const { provider: chosen, apiKey } = await this.resolveProvider(
      tenantId,
      environmentId,
      provider,
    );
    const { text: resources, connectionIds } = await this.buildResourceContext(
      tenantId,
      environmentId,
    );
    // The instruction block: an EDIT framing when there's a draft to change, else a plain create.
    //
    // The preservation rules are load-bearing, not politeness. "Return the COMPLETE graph" on its
    // own reads to a model as "write the whole graph", and it obliges — same intent, fresh ids,
    // reworded prompts, a new name. The user then can't tell an edit from a rewrite, and any
    // hand-tuning they'd done on untouched nodes is gone. Naming what must survive turns the
    // full-graph requirement into a transcription of the input plus the change.
    const userPrompt = edit.previous
      ? `You are EDITING an existing workflow. Here is the current graph (JSON):\n${JSON.stringify(edit.previous)}\n\nApply this change and return the COMPLETE updated workflow graph (the full graph, not a diff or a partial):\n${instruction}\n\nPRESERVE everything the change does not require altering:\n- Keep the workflow's "name" exactly as it is unless the change is about the name.\n- Keep every existing node's id, type and config BYTE-FOR-BYTE unless that node is what the change is about. Do not rename ids, reword systemPrompts, reformat values, or "improve" anything you were not asked to touch.\n- Keep every existing edge (and its condition) unless the change requires rewiring it.\n- ADD only the nodes/edges the change needs, and REMOVE only what it makes obsolete.\nA node you leave alone must come back identical to how it arrived.`
      : instruction;

    // First attempt (streamed for API models + hooks; claude-code + one-shot don't stream).
    let out: GraphDraft;
    let tokens: GenTokens | null = null;
    if (chosen !== CLAUDE_CODE && hooks) {
      ({ draft: out, tokens } = await this.callMeteredStreaming(
        chosen,
        apiKey,
        userPrompt,
        resources,
        hooks,
      ));
    } else if (chosen === CLAUDE_CODE) {
      out = await this.callClaudeCode(apiKey, userPrompt, resources, timeoutMs);
    } else {
      ({ draft: out, tokens } = await this.callMeteredOneShot(
        chosen,
        apiKey,
        userPrompt,
        resources,
      ));
    }
    this.logDraftShape("edit", out);
    let graph = toGraphDef(out);
    let check = this.validate(graph);

    // One repair retry (non-streamed, usage not re-metered — rare): feed the validator error back.
    if (!check.valid) {
      out = await this.callModel(
        chosen,
        apiKey,
        userPrompt,
        {
          previous: JSON.stringify(out),
          error: check.error ?? "invalid graph",
        },
        resources,
        timeoutMs,
      );
      this.logDraftShape(`edit-repair(${check.error})`, out);
      graph = toGraphDef(out);
      check = this.validate(graph);
      if (!check.valid) {
        throw new UnprocessableEntityException(
          `Couldn't apply the change (${check.error}). Try rephrasing it.`,
        );
      }
    }

    // Same self-verify/self-repair as the create path — an edit turn can introduce an unknown
    // action or drop a required field just as easily as a create.
    const editConfigErrors = this.modelFixableConfigErrors(graph);
    if (editConfigErrors.length > 0) {
      graph = await this.selfRepairConfig(
        graph,
        editConfigErrors,
        async (text) => {
          const fixed = await this.callModel(
            chosen,
            apiKey,
            userPrompt,
            { previous: JSON.stringify(out), error: text },
            resources,
            timeoutMs,
          );
          this.logDraftShape("edit-config-repair", fixed);
          return toGraphDef(fixed);
        },
      );
    }

    // Same enforcement as the create path: a conversational EDIT can invent a connectionId just as
    // easily, and the turn is applied to the draft the user then saves.
    const inventedEdit = this.scrubInventedConnections(graph, connectionIds);
    if (inventedEdit.length > 0) {
      this.logger.warn(
        `builder turn: blanked ${inventedEdit.length} invented connectionId(s) — ${inventedEdit.join(", ")}`,
      );
    }

    // Always a real PRICED pair (claude-code → anthropic/opus) so an estimate can still cost it.
    const pricedProvider: GenProvider =
      chosen === CLAUDE_CODE ? "anthropic" : chosen;
    return {
      name:
        out.name?.trim() || (edit.previous ? "Workflow" : "Generated workflow"),
      graph,
      meter: {
        provider: pricedProvider,
        model: GEN_DEFAULT_MODEL[pricedProvider],
        tokens,
      },
    };
  }

  /** Shared body for {@link generate} + {@link generateStream}. Hooks (when present) make
   *  the first API-model draft stream; everything else — provider resolution, resource
   *  grounding, validate, one repair — is identical. */
  private async generateInternal(
    tenantId: string,
    environmentId: string,
    prompt: string,
    provider?: string,
    opts?: {
      timeoutMs?: number;
      onMeta?: (name: string) => void;
      onNode?: (node: unknown) => void;
      onEdge?: (edge: unknown) => void;
    },
  ): Promise<{ name: string; graph: GraphDef }> {
    const description = prompt?.trim();
    if (!description)
      throw new BadRequestException("A description is required");
    const timeoutMs = opts?.timeoutMs ?? CLAUDE_CODE_TIMEOUT_MS;
    const hooks =
      opts?.onMeta || opts?.onNode || opts?.onEdge
        ? { onMeta: opts.onMeta, onNode: opts.onNode, onEdge: opts.onEdge }
        : undefined;

    // Env-scoped (Slice 5): use THIS env's provider key + connections to ground generation.
    const { provider: chosen, apiKey } = await this.resolveProvider(
      tenantId,
      environmentId,
      provider,
    );

    // Ground the model in this env's real connections + the integration action catalog.
    const { text: resources, connectionIds } = await this.buildResourceContext(
      tenantId,
      environmentId,
    );

    // First attempt (streamed when hooks are present AND the provider is an API model).
    let out = await this.firstDraft(
      chosen,
      apiKey,
      description,
      resources,
      timeoutMs,
      hooks,
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
        timeoutMs,
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

    // SELF-VERIFY, then SELF-REPAIR: check the draft against the integration catalog and, if it got
    // something wrong that a model CAN fix (unknown action, missing required field), hand it back
    // for one corrective pass. Runs before the connection scrub so anything the repair introduces
    // is scrubbed too.
    const configErrors = this.modelFixableConfigErrors(graph);
    if (configErrors.length > 0) {
      graph = await this.selfRepairConfig(graph, configErrors, async (text) => {
        const fixed = await this.callModel(
          chosen,
          apiKey,
          description,
          { previous: JSON.stringify(out), error: text },
          resources,
          timeoutMs,
        );
        this.logDraftShape("config-repair", fixed);
        return toGraphDef(fixed);
      });
    }

    // The model is TOLD to use only real connection ids and not to invent any; this is where that
    // is enforced (see scrubInventedConnections). Runs after the repair loop so a repaired draft is
    // scrubbed too, and logs the ids only — never the graph, never config values.
    const invented = this.scrubInventedConnections(graph, connectionIds);
    if (invented.length > 0) {
      this.logger.warn(
        `graph generate: blanked ${invented.length} invented connectionId(s) — ${invented.join(", ")}`,
      );
    }

    return { name: out.name?.trim() || "Generated workflow", graph };
  }

  /** First-draft dispatch: stream (API models + hooks) or the plain one-shot call. */
  private async firstDraft(
    chosen: GenSource,
    apiKey: string,
    description: string,
    resources: string,
    timeoutMs: number,
    hooks?: StreamHooks,
  ): Promise<GraphDraft> {
    if (chosen !== CLAUDE_CODE && hooks) {
      return this.callModelStreaming(
        chosen,
        apiKey,
        description,
        resources,
        hooks,
      );
    }
    return this.callModel(
      chosen,
      apiKey,
      description,
      undefined,
      resources,
      timeoutMs,
    );
  }

  /**
   * Catalog problems the MODEL can fix on a second pass — an unknown provider/action, or a missing
   * REQUIRED field. Returned as prompt-ready lines naming the node.
   *
   * DELIBERATELY EXCLUDES the missing-connectionId case. No prompt can conjure a connection the
   * tenant hasn't created, so feeding that back would burn a repair turn and still fail; it belongs
   * to the author, and the canvas issues panel asks for it (#831).
   *
   * WHAT THIS ADDS over the structural pass, precisely: `validateGraph` already rejects an unknown
   * provider/action, and the existing repair loop fixes those. It does NOT check whether an
   * action's REQUIRED FIELDS were supplied — so the classic generator miss, a real action with an
   * empty `owner`/`repo`/`title`, reached the canvas looking configured and failed on the first
   * run. The generator knew how to check this; it just never checked its own output.
   */
  private modelFixableConfigErrors(graph: GraphDef): string[] {
    const out: string[] = [];
    for (const node of graph.nodes) {
      if (node.type !== "integration") continue;
      const err = validateIntegrationConfig(
        (node.config ?? {}) as unknown as Parameters<
          typeof validateIntegrationConfig
        >[0],
      );
      // The connection error is the author's to resolve — see above.
      if (!err || /needs a connectionId/.test(err)) continue;
      out.push(`node "${node.id}": ${err}`);
    }
    return out;
  }

  /**
   * Ask the model to fix its own catalog mistakes, and keep the result ONLY if it is actually
   * better. A repair can regress — a model handed an error list can rewrite more than it was asked
   * to — so the new draft has to be structurally valid AND carry strictly fewer config errors, or
   * the original stands. Never fatal: a flow with a remaining config gap is still worth handing to
   * the author (the issues panel names it) and is far better than refusing to generate.
   */
  private async selfRepairConfig(
    graph: GraphDef,
    errors: string[],
    repair: (errorText: string) => Promise<GraphDef | null>,
  ): Promise<GraphDef> {
    this.logger.log(
      `graph generate: self-repairing ${errors.length} catalog issue(s)`,
    );
    let repaired: GraphDef | null = null;
    try {
      repaired = await repair(
        `The workflow uses the integration catalog incorrectly. Fix ONLY these, keeping everything else identical:\n${errors.join("\n")}`,
      );
    } catch {
      return graph; // a failed repair must never fail the generation
    }
    if (!repaired || !this.validate(repaired).valid) return graph;
    const after = this.modelFixableConfigErrors(repaired);
    if (after.length >= errors.length) {
      this.logger.warn(
        `graph generate: self-repair did not improve (${errors.length} → ${after.length}) — keeping the original draft`,
      );
      return graph;
    }
    this.logger.log(
      `graph generate: self-repair fixed ${errors.length - after.length} of ${errors.length}`,
    );
    return repaired;
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
  ): Promise<{ provider: GenSource; apiKey: string }> {
    let provider = requested?.trim() as GenSource | undefined;
    if (
      provider &&
      !GEN_PROVIDERS.includes(provider as GenProvider) &&
      provider !== CLAUDE_CODE
    ) {
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
      // API-model providers first (faster, no subprocess); a claude-code credential
      // (possibly a subscription setup-token) is the fallback that makes a
      // claude-code-only tenant able to generate.
      provider =
        GEN_PROVIDERS.find((p) => valid.has(p)) ??
        (valid.has(CLAUDE_CODE) ? CLAUDE_CODE : undefined);
      if (!provider) {
        throw new BadRequestException(
          "Add a model provider key (Anthropic, OpenAI, or Google) or a Claude Code credential in Integrations before generating a workflow.",
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
    provider: GenSource,
    apiKey: string,
    description: string,
    repair: { previous: string; error: string } | undefined,
    resources: string,
    timeoutMs: number,
  ): Promise<GraphDraft> {
    const userPrompt = repair
      ? `The previous graph was invalid: ${repair.error}\n\nPrevious graph:\n${repair.previous}\n\nFix it. Original request:\n${description}`
      : description;
    if (provider === CLAUDE_CODE) {
      // timeoutMs only bounds the CLI subprocess; the AI-SDK path below has no per-call
      // timeout today (unchanged), and the SSE transport removes its 504 risk anyway.
      return this.callClaudeCode(apiKey, userPrompt, resources, timeoutMs);
    }
    // Plain-text generation (NOT Output.object): the structured-output path returned a
    // skeleton — nodes with id+type but empty edges and empty config, even on repair.
    // Free-form generation follows the prompt (few-shot + fill rules), so the model
    // actually writes edges + config; the JSON is parsed + validated (+ repair) below.
    let text: string;
    try {
      const { generateText } = await aiSdk();
      const result = await generateText({
        model: await buildGenModel(provider, apiKey),
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
        `graph generate failed (provider=${provider}): ${await describeProviderError(e)}`,
      );
      throw await mapProviderError(e, provider);
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

  /**
   * Streamed first-draft for the API-model providers (NOT claude-code, NOT the repair
   * pass): same SYSTEM_PROMPT + user prompt as {@link callModel} (so generation quality is
   * unchanged — still free-form JSON, never Output.object), but via `streamText`. As deltas
   * arrive we accumulate them and run the incremental extractor over the growing buffer,
   * invoking the hooks with each complete node/edge (and the name) the moment it parses.
   * The full accumulated text is then parsed once at end-of-stream, exactly like the
   * non-streaming path. `textStream` rethrows provider errors on iteration (per the AI SDK
   * contract), so the catch below maps them the same way as the one-shot call.
   */
  private async callModelStreaming(
    provider: GenSource,
    apiKey: string,
    description: string,
    resources: string,
    hooks: StreamHooks,
  ): Promise<GraphDraft> {
    let text = "";
    const extractor = createGraphStreamExtractor();
    try {
      const { streamText } = await aiSdk();
      const result = streamText({
        model: await buildGenModel(provider as GenProvider, apiKey),
        system: SYSTEM_PROMPT,
        prompt: `${description}\n\n${resources}Respond with ONLY the JSON graph object — start at { and end at }. No prose, no markdown code fences.`,
        maxOutputTokens: 16000,
        // Never crash the request on a stream error — textStream rethrows it below; this
        // just suppresses the SDK's default console.error (which could echo request detail).
        onError: () => {},
      });
      for await (const delta of result.textStream) {
        text += delta;
        // Extract over the CUMULATIVE buffer; the wrapper yields only what's newly complete.
        const got = extractor.push(text);
        if (got.name && hooks.onMeta) hooks.onMeta(got.name);
        if (hooks.onNode) for (const n of got.nodes) hooks.onNode(n);
        if (hooks.onEdge) for (const e of got.edges) hooks.onEdge(e);
      }
    } catch (e) {
      this.logger.warn(
        `graph generate (stream) failed (provider=${provider}): ${await describeProviderError(e)}`,
      );
      throw await mapProviderError(e, provider);
    }
    const parsed = parseGraphJson(text);
    if (!parsed) {
      this.logger.warn(
        `graph generate (stream): model returned unparseable JSON (head: ${text.slice(0, 120).replace(/\s+/g, " ")})`,
      );
      throw new UnprocessableEntityException(
        "The model didn't return a valid workflow. Try rephrasing the description.",
      );
    }
    return parsed;
  }

  /**
   * Metered one-shot (builder edit/create, API models): same free-form generate as
   * {@link callModel}'s API branch, but takes a pre-built user prompt and RETURNS the reported
   * usage (null when the provider gave none — the caller estimates, Tier-1 §6). No repair here.
   */
  private async callMeteredOneShot(
    provider: GenProvider,
    apiKey: string,
    userPrompt: string,
    resources: string,
  ): Promise<{ draft: GraphDraft; tokens: GenTokens | null }> {
    let text: string;
    let rawUsage: unknown;
    try {
      const { generateText } = await aiSdk();
      const result = await generateText({
        model: await buildGenModel(provider, apiKey),
        system: SYSTEM_PROMPT,
        prompt: `${userPrompt}\n\n${resources}Respond with ONLY the JSON graph object — start at { and end at }. No prose, no markdown code fences.`,
        maxOutputTokens: 16000,
      });
      text = result.text;
      // totalUsage sums tool-loop steps (CLAUDE.md); no tools here, but prefer it for correctness.
      rawUsage =
        (result as { totalUsage?: unknown }).totalUsage ??
        (result as { usage?: unknown }).usage;
    } catch (e) {
      this.logger.warn(
        `graph edit failed (provider=${provider}): ${await describeProviderError(e)}`,
      );
      throw await mapProviderError(e, provider);
    }
    const parsed = parseGraphJson(text);
    if (!parsed) {
      this.logger.warn(
        `graph edit: model returned unparseable JSON (head: ${text.slice(0, 120).replace(/\s+/g, " ")})`,
      );
      throw new UnprocessableEntityException(
        "The model didn't return a valid workflow. Try rephrasing the change.",
      );
    }
    return { draft: parsed, tokens: readGenTokens(rawUsage) };
  }

  /**
   * Metered streamed first-draft (builder edit/create, API models): same streaming as
   * {@link callModelStreaming} (per-element hooks over the growing buffer) but takes a pre-built
   * user prompt and RETURNS the reported usage after the stream drains (null when absent).
   */
  private async callMeteredStreaming(
    provider: GenProvider,
    apiKey: string,
    userPrompt: string,
    resources: string,
    hooks: StreamHooks,
  ): Promise<{ draft: GraphDraft; tokens: GenTokens | null }> {
    let text = "";
    let rawUsage: unknown;
    const extractor = createGraphStreamExtractor();
    try {
      const { streamText } = await aiSdk();
      const result = streamText({
        model: await buildGenModel(provider, apiKey),
        system: SYSTEM_PROMPT,
        prompt: `${userPrompt}\n\n${resources}Respond with ONLY the JSON graph object — start at { and end at }. No prose, no markdown code fences.`,
        maxOutputTokens: 16000,
        onError: () => {},
      });
      for await (const delta of result.textStream) {
        text += delta;
        const got = extractor.push(text);
        if (got.name && hooks.onMeta) hooks.onMeta(got.name);
        if (hooks.onNode) for (const n of got.nodes) hooks.onNode(n);
        if (hooks.onEdge) for (const e of got.edges) hooks.onEdge(e);
      }
      // Usage resolves once the stream completes; never let a metering read throw.
      rawUsage = await Promise.resolve(
        (result as { totalUsage?: unknown }).totalUsage,
      ).catch(() => undefined);
    } catch (e) {
      this.logger.warn(
        `graph edit (stream) failed (provider=${provider}): ${await describeProviderError(e)}`,
      );
      throw await mapProviderError(e, provider);
    }
    const parsed = parseGraphJson(text);
    if (!parsed) {
      this.logger.warn(
        `graph edit (stream): model returned unparseable JSON (head: ${text.slice(0, 120).replace(/\s+/g, " ")})`,
      );
      throw new UnprocessableEntityException(
        "The model didn't return a valid workflow. Try rephrasing the change.",
      );
    }
    return { draft: parsed, tokens: readGenTokens(rawUsage) };
  }

  /**
   * Generate via the headless Claude Code CLI (`claude -p`) — bills to the tenant's
   * Claude Code credential (a subscription setup-token or an API key), not a
   * platform API key. Same system prompt + resource grounding as the API path;
   * plan mode + a read-only tool clamp + one turn mirror the proven codeAgent
   * read-only envelope (no edits, no Bash, minimal env — key never logged).
   */
  private async callClaudeCode(
    apiKey: string,
    userPrompt: string,
    resources: string,
    timeoutMs: number,
  ): Promise<GraphDraft> {
    const args = [
      "-p",
      `${userPrompt}\n\n${resources}Respond with ONLY the JSON graph object — start at { and end at }. No prose, no markdown code fences.`,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--allowedTools",
      "Read,Grep,Glob",
      // The turn budget is NOT the real bound — `timeoutMs` (55s) is, and it is enforced by the
      // spawn wrapper regardless. This only stops a pathological loop, so it should be generous:
      // at 4 a realistic multi-node request ("incident → agent → GitHub issue → ack → trigger
      // another workflow") hit `error_max_turns` and failed outright, because tool digressions
      // (the Read/Grep/Glob grant above) each cost a turn before any JSON is emitted. Raising it
      // cannot make a request slower than the timeout already allows — it only stops us failing a
      // request the model was still making progress on.
      "--max-turns",
      "12",
      "--append-system-prompt",
      SYSTEM_PROMPT,
    ];
    // The CLI runs in the sandbox now (#680), so the runner must be deployed. Check the config
    // FIRST and answer with the operator's actual next step: with `COMPOSE_PROFILES=sandbox` off,
    // the `sandbox-runner` service doesn't exist and even its hostname won't resolve, so the
    // network error below would otherwise be the only clue.
    const runner = sandboxRunnerConfig();
    if (!runner.url || !runner.token) {
      throw new ServiceUnavailableException(
        "Claude Code generation runs in the isolated sandbox, which isn't configured on this server (SANDBOX_RUNNER_URL / SANDBOX_RUNNER_TOKEN; see deploy/sandbox/README.md). Add an Anthropic/OpenAI/Google API key in Integrations to generate without it.",
      );
    }
    // authEnv gives { [varName]: value } — exactly one entry (an API key → ANTHROPIC_API_KEY, a
    // subscription setup-token → CLAUDE_CODE_OAUTH_TOKEN). The runner forwards it into the
    // container BY NAME; the value never touches an argv, a log, or this response.
    const [keyEnvVar, authKey] = Object.entries(claudeCodeAuthEnv(apiKey))[0];

    let stdout: string;
    let stderr: string | undefined;
    let exitCode: number;
    try {
      ({ stdout, stderr, exitCode } = await __genDeps.runSandbox(
        {
          // No repo and no git: an empty, per-run directory the runner creates and deletes.
          workspace: "ephemeral",
          // The runner maps the TOOL to its own pinned image. The API can't name an image — the
          // runner holds the Docker socket, so that would be a host-root injection surface.
          tool: "claude",
          agentArgs: args,
          authKey,
          keyEnvVar,
          timeoutMs,
        },
        { timeoutMs },
      ));
    } catch (e) {
      this.logger.warn(
        // Class + name only — the error message can echo argv (which contains the prompt).
        `graph generate (claude-code): sandbox dispatch failed (${e instanceof Error ? e.name : "unknown"})`,
      );
      throw new ServiceUnavailableException(
        "Claude Code couldn't run: the isolated sandbox is unreachable or took too long. Try again, or add an API-model provider key in Integrations.",
      );
    }

    // `claude -p --output-format json` emits one JSON envelope; is_error is checked
    // even on exit 0 (mirrors the codeAgent driver's parse).
    let result = "";
    let subtype: string | undefined;
    let isError = exitCode !== 0;
    /** Non-secret envelope fields, logged on any failure so prod names its own cause. */
    let diagnostics = "turns=? (no envelope)";
    try {
      const envlp = JSON.parse(stdout.trim()) as {
        result?: string;
        is_error?: boolean;
        /** The CLI's failure reason (e.g. "error_max_turns") — often the ONLY clue when
         *  result and stderr are both empty. */
        subtype?: string;
        /** Turns actually consumed, why it stopped, whether the API errored, and which tool calls
         *  were REFUSED. All non-secret, and together they distinguish the failure modes that look
         *  identical from outside — see `diagnostics` below. */
        num_turns?: number;
        stop_reason?: string;
        terminal_reason?: string;
        api_error_status?: unknown;
        permission_denials?: unknown[];
        duration_ms?: number;
        modelUsage?: Record<string, unknown>;
      };
      subtype = typeof envlp.subtype === "string" ? envlp.subtype : undefined;
      result = typeof envlp.result === "string" ? envlp.result : "";
      isError = isError || envlp.is_error === true;
      /**
       * Why these are logged (#build-ai): a turn-capped generate could NOT be reproduced locally —
       * five live variants of the exact shipped invocation (with/without the tool grant, turn
       * budget 4 and 12, empty and project cwd) all produced the 6-node graph in ONE turn. So the
       * cause is environmental, and the two candidates are invisible today:
       *   - `permission_denials` — a tool call refused under `--permission-mode plan` can loop:
       *     attempt, denial, attempt … each one a turn, ending capped with an EMPTY result, which is
       *     exactly the shape this branch handles.
       *   - `api_error_status` — a provider overload/limit makes the model stall rather than answer.
       * `num_turns` alone settles whether the budget was even reached. Names of models and tools are
       * not secrets; the user's instruction is never included.
       */
      diagnostics = [
        `turns=${envlp.num_turns ?? "?"}`,
        `stop=${envlp.stop_reason ?? "?"}`,
        `terminal=${envlp.terminal_reason ?? "?"}`,
        `apiError=${envlp.api_error_status === undefined ? "none" : JSON.stringify(envlp.api_error_status).slice(0, 80)}`,
        `denials=${Array.isArray(envlp.permission_denials) ? envlp.permission_denials.length : 0}`,
        `durationMs=${envlp.duration_ms ?? "?"}`,
        `models=${Object.keys(envlp.modelUsage ?? {}).join(",") || "?"}`,
      ].join(" ");
    } catch {
      isError = true;
    }
    if (isError) {
      // The CLI's error surface: the JSON envelope's `result` (when it emitted one) AND stderr
      // (where it writes the real reason when it exits before/without JSON — the common empty-head
      // case). Classify + log against BOTH.
      const errText = [result, stderr].filter(Boolean).join(" | ").trim();
      // Redact secret-shaped substrings — the CLI's stderr could echo a token/key, and this head is
      // logged at error level (→ Sentry / log aggregation).
      const head = redactString(errText.slice(0, 200).replace(/\s+/g, " "));
      // User-fixable cases → a 4xx telling the user what to do; keep these at warn (expected,
      // AUTH/QUOTA are filtered from issue capture — they're the user's to fix, not an outage).
      if (/invalid api key|authentication|unauthorized|oauth/i.test(errText)) {
        this.logger.warn(
          `graph generate (claude-code): credential rejected (exit=${exitCode})`,
        );
        throw new BadRequestException(
          "Your Claude Code credential was rejected. Update it in Integrations → Code Agent.",
        );
      }
      if (/rate limit|usage limit|overloaded|quota/i.test(errText)) {
        this.logger.warn(
          `graph generate (claude-code): rate/usage limit (exit=${exitCode})`,
        );
        throw new HttpException(
          "Claude Code is rate-limited or your usage limit is reached. Try again shortly.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // A turn-capped run (the model spent turns on tool calls without emitting the JSON) is a
      // known, retryable shape — tell the user that instead of a generic failure. Kept at warn:
      // it's a model-behavior hiccup, not an outage.
      if (subtype === "error_max_turns") {
        this.logger.warn(
          `graph generate (claude-code): turn-capped without a result (exit=${exitCode}) ${diagnostics}`,
        );
        throw new ServiceUnavailableException(
          "Claude Code hit its internal step limit before producing the workflow. This is usually transient — try again. If it repeats on the same description, switch the provider: Claude, GPT and Gemini stream the graph directly and have no step limit.",
        );
      }
      // Unknown/unexpected failure — surface as an ERROR (a real problem worth an alert, not just a
      // warn), with the stderr head AND the envelope subtype (often the only clue when both
      // streams are empty).
      this.logger.error(
        `graph generate (claude-code): CLI reported failure (exit=${exitCode}, subtype=${subtype ?? "none"}, ${diagnostics}, head: ${head})`,
      );
      throw new ServiceUnavailableException(
        "Claude Code couldn't generate a workflow right now. Try again.",
      );
    }
    const parsed = parseGraphJson(result);
    if (!parsed) {
      this.logger.warn(
        `graph generate (claude-code): unparseable JSON (head: ${result.slice(0, 120).replace(/\s+/g, " ")})`,
      );
      throw new UnprocessableEntityException(
        "The model didn't return a valid workflow. Try rephrasing the description.",
      );
    }
    return parsed;
  }
}
