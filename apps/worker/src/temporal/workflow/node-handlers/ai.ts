// AI / tool / integration leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE: arg/field
// resolution is pure + in-workflow; the BYOK key fetch + LLM/MCP/HTTP I/O runs in the
// SAME activity proxies run-graph.ts uses. Cost-bearing handlers return their `costUsd`
// DELTA; the dispatch accumulates it + stamps `ctx.__costUsd`. `activities` is TYPE-ONLY.
import {
  resolveMcpArguments,
  resolveIntegrationFields,
  getIntegrationAction,
  asNodeConfig,
  getByPath,
} from "@naary/dsl";
import * as wf from "@temporalio/workflow";
import type { NodeOutputMap } from "@naary/dsl";
import type * as activities from "../../activities";
import {
  runAgent,
  runAgentTooled,
  callMcpTool,
  callCodeAgent,
  callCodeAgentHeavy,
  callTextToSpeech,
  callIntegrationRead,
  callIntegrationWrite,
  retryOverride,
} from "../proxies";
import type { NodeHandler } from "./contract";

export const handleAgent: NodeHandler = async ({
  cfg,
  ctx,
  node,
  runCtx,
  metaFor,
}) => {
  // tenantId flows in workflow args (not a secret); the activity fetches
  // the tenant's key by tenantId. executionId is deterministic.
  const agentCfg = cfg as unknown as activities.AgentConfig;

  // Claude Code as an Agent provider: run the agent's instruction through the Claude Code CLI
  // (the codeAgent activity, read-mode plan run) instead of a raw LLM call. The provider check is
  // FIRST so wf.patched is only reached on this NEW path — existing agent histories keep the exact
  // runAgent command sequence (replay-safe). Billing flows through the code-agent activity's own
  // recordUsage (same as a codeAgent node), so there's no double/under-count.
  if (
    agentCfg.provider === "claude-code" &&
    wf.patched("agent-claude-code-v1")
  ) {
    // The CLI's `-p` prompt is the PRIMARY instruction slot (systemPrompt only appends to the
    // CLI's own system prompt), so the agent's systemPrompt IS the prompt; the upstream input is
    // appended as data. This mirrors how a codeAgent node's `prompt` is meant to be filled, NOT
    // runAgent's system/user split (which would demote the real instruction).
    const parts: string[] = [];
    if (agentCfg.systemPrompt) parts.push(agentCfg.systemPrompt);
    if (ctx.__input !== undefined && ctx.__input !== null)
      parts.push(`Input:\n${JSON.stringify(ctx.__input)}`);
    const prompt = parts.join("\n\n") || "Respond to the input.";
    // Same heavy-queue + test-mode split as handleCodeAgent (this IS a codeAgent run).
    const callCa =
      wf.patched("heavy-queue-v1") && !runCtx.test
        ? callCodeAgentHeavy
        : callCodeAgent;
    const caResult = await callCa(
      {
        tool: "claude",
        prompt,
        model: agentCfg.model,
        // The agent's own outputSchema works on this path too: the CLI enforces it
        // (`--json-schema`) exactly as the provider does on the raw-LLM path. Adding a FIELD to an
        // activity's input doesn't change the workflow's command sequence, and an existing history
        // can't have carried a schema (it was never passed), so replay is unaffected.
        ...(agentCfg.outputSchema
          ? { outputSchema: agentCfg.outputSchema }
          : {}),
      },
      ctx.__input,
      metaFor(node.id),
    );
    // Normalize to the AGENT output shape so downstream `agent.output.*` expressions keep working:
    // a schema'd run yields the structured object AS the output (identical to the raw-LLM path);
    // otherwise the Claude Code result text becomes `output.text` (a schema-less agent's free text).
    ctx[node.id] = {
      status: "ok",
      output: caResult.output.structured ?? { text: caResult.output.result },
      model: agentCfg.model ?? "claude-code",
      costUsd: caResult.costUsd,
    } satisfies NodeOutputMap["agent"];
    return { costUsd: caResult.costUsd };
  }

  // Tooled agents (#449) run a multi-step loop with nested MCP calls → a longer deadline
  // and AT-MOST-ONCE by default (runAgentTooled), so a retried activity never replays an
  // already-executed tool. An explicit NodeDef.retry still wins (and gets the long timeout).
  const tooled = (agentCfg.tools?.length ?? 0) > 0;
  const over = retryOverride(node.retry, tooled ? 300_000 : 60_000);
  const runFn = over?.runAgent ?? (tooled ? runAgentTooled : runAgent);
  const result = await runFn(agentCfg, ctx.__input, metaFor(node.id));
  ctx[node.id] = result satisfies NodeOutputMap["agent"];
  // Cost is a commutative SUM — accumulating it is order-independent (safe
  // even under parallel fan-out, where Temporal replays activity completion
  // order deterministically anyway).
  return { costUsd: result.costUsd };
};

export const handleCodeAgent: NodeHandler = async ({
  cfg,
  ctx,
  node,
  runCtx,
  metaFor,
}) => {
  // The prompt's {{…}} is already resolved in `cfg`. No retryOverride: this node is
  // AT-MOST-ONCE (its proxy block pins maximumAttempts:1) — later slices commit/PR,
  // so a partial write must never auto-retry. The activity fetches the BYOK key.
  const caCfg = asNodeConfig(cfg, "codeAgent");
  // Heavy-queue routing (Queue-mode §3.3): codeAgent is the long/heavy node, so route it to the
  // dedicated pool (orchestrator-heavy). STATIC per activity (not a runtime/env read — replay-safe).
  // wf.patched only preserves REPLAY determinism: a history that already ran this step keeps its
  // original queue. A run reaching codeAgent for the FIRST time after this deploy (even one started
  // earlier) DOES take the heavy queue — hence the hard deploy-order rule that the heavy pool be up
  // first, else those activities strand. Test-mode runs stay on the default queue (`!runCtx.test`)
  // so the single-queue e2e/live worker isn't stranded (the heavy proxy is asserted in the unit test).
  const callCa =
    wf.patched("heavy-queue-v1") && !runCtx.test
      ? callCodeAgentHeavy
      : callCodeAgent;
  const caResult = await callCa(
    {
      tool: caCfg.tool,
      prompt: caCfg.prompt,
      systemPrompt: caCfg.systemPrompt,
      model: caCfg.model,
      maxTurns: caCfg.maxTurns,
      maxBudgetUsd: caCfg.maxBudgetUsd,
      timeoutMs: caCfg.timeoutMs,
      costUsd: caCfg.costUsd,
      // Structured output: the CLI is constrained to this JSON Schema and the parsed object comes
      // back on `output.structured`. Passed straight through — the ACTIVITY decides whether the
      // chosen driver can enforce it (and refuses if not), because that is a runtime capability,
      // not something this deterministic handler should judge.
      outputSchema: caCfg.outputSchema,
      // Write mode (Slice 2c): the activity clones `repo` (via the App `connectionId`) and
      // dispatches to the sandbox-runner; default/read runs in-worker with no repo.
      mode: caCfg.mode,
      repo: caCfg.repo,
      branch: caCfg.branch,
      connectionId: caCfg.connectionId,
      // Write + PR (#444): commit the sandbox's edits to a branch, push, open a PR.
      openPr: caCfg.openPr,
      prTitle: caCfg.prTitle,
      prBody: caCfg.prBody,
      commitMessage: caCfg.commitMessage,
      headBranch: caCfg.headBranch,
    },
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = caResult satisfies NodeOutputMap["codeAgent"];
  return { costUsd: caResult.costUsd };
};

export const handleTextToSpeech: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // `text`'s {{…}} is already resolved in `cfg`; `textBinding` is resolved HERE because a ctx read
  // is pure, deterministic graph work (same split as hash/hmac). The synthesis, the BYOK key fetch,
  // and the object-storage write all live in the activity. NOTE: the resolved text is a workflow
  // ARGUMENT, so it does appear in Temporal history — same as an agent node's prompt; it is the
  // AUDIO (and the key) that must never be there.
  const ttsCfg = asNodeConfig(cfg, "textToSpeech");
  const bound = ttsCfg.textBinding
    ? getByPath(ctx[ttsCfg.textBinding.from], ttsCfg.textBinding.path)
    : undefined;
  const text =
    bound === undefined || bound === null
      ? (ttsCfg.text ?? "")
      : typeof bound === "string"
        ? bound
        : JSON.stringify(bound);
  const over = retryOverride(node.retry, 300_000);
  const result = await (over?.callTextToSpeech ?? callTextToSpeech)(
    {
      provider: ttsCfg.provider,
      text,
      voice: ttsCfg.voice,
      model: ttsCfg.model,
      format: ttsCfg.format,
      speed: ttsCfg.speed,
      timeoutMs: ttsCfg.timeoutMs,
      costUsd: ttsCfg.costUsd,
    },
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = result satisfies NodeOutputMap["textToSpeech"];
  // Meter TTS spend into the run budget (commutative accumulation, same as the agent node).
  return { costUsd: result.costUsd };
};

export const handleMcpTool: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Resolving tool args from upstream outputs is deterministic graph work,
  // so it happens HERE; the I/O (token fetch + HTTP) is inside the activity.
  const mcpCfg = asNodeConfig(cfg, "mcpTool");
  const over = retryOverride(node.retry, 60_000);
  const toolResult = await (over?.callMcpTool ?? callMcpTool)(
    {
      connectionId: mcpCfg.connectionId,
      tool: mcpCfg.tool,
      arguments: resolveMcpArguments(mcpCfg, ctx),
      costUsd: mcpCfg.costUsd,
    },
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = toolResult satisfies NodeOutputMap["mcpTool"];
  // Meter tool spend into the run budget so the per-execution cap sees it
  // (Arch§4.6) — commutative accumulation, same as the agent node.
  return { costUsd: toolResult.costUsd };
};

export const handleIntegration: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Native provider action. Field resolution (static + bindings) is deterministic
  // graph work → HERE; the auth fetch + egress + HTTP is in the activity. A WRITE
  // action runs AT-MOST-ONCE (no retry) so a lost response can't duplicate a create
  // (design §4); reads retry. No per-node retryOverride — the write/read split governs
  // idempotency and a retry override must never re-enable retries on a write.
  const iCfg = asNodeConfig(cfg, "integration");
  const action = getIntegrationAction(iCfg.provider, iCfg.action);
  const runIntegration = action?.write
    ? callIntegrationWrite
    : callIntegrationRead;
  ctx[node.id] = (await runIntegration(
    iCfg,
    resolveIntegrationFields(iCfg, ctx),
    metaFor(node.id),
  )) satisfies NodeOutputMap["integration"];
  return;
};
