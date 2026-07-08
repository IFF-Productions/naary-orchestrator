import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { GraphDef, NodeDef } from "@naary/dsl";
import { isPureNode, runPureNode } from "@naary/dsl";
import { TenantId } from "../auth/tenant.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { PinsService } from "./pins.service";

/** Node types with no output-producing behavior to test in isolation — control/wait/trigger
 *  nodes. (Pure + activity nodes are testable; these need the full flow.) */
const UNTESTABLE_NODE_TYPES = new Set<string>([
  "start",
  "end",
  "wait",
  "humanApproval",
  "forEach",
  "executeSubWorkflow",
  "webhookTrigger",
  "scheduleTrigger",
  "pollTrigger",
  "errorTrigger",
  "respondToWebhook",
  "merge",
  "stopAndError",
]);

/**
 * Pinned node outputs for the canvas authoring loop (design SINGLE-NODE-EXECUTION.md §5).
 * Graph-scoped by workflowKey; tenant comes from the token, never the body. Pins are authoring-only
 * — the interpreter never reads them.
 */
@ApiBearerAuth("bearer")
@Controller("graphs/:workflowKey")
export class PinsController {
  constructor(
    private readonly pins: PinsService,
    private readonly graphs: GraphsService,
    private readonly executions: ExecutionsService,
  ) {}

  /**
   * Single-node "Test" (design SINGLE-NODE-EXECUTION.md slices 2–3): run ONE node against a
   * mini-ctx built from the workflow's pins (+ optional `inputs` override), returning its output —
   * without a full run. PURE nodes run instantly in-process; ACTIVITY nodes run the real activity
   * via a short-lived test-mode Temporal exec (secrets in-activity, billing counts); control/wait
   * nodes report `pure:false` (not testable in isolation).
   */
  @ApiEndpoint({
    summary: "Test-run a single node against pinned/sample inputs",
    notFound: true,
  })
  @Post("nodes/:nodeId/test")
  async test(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
    @Body()
    body: {
      inputs?: Record<string, unknown>;
      /** Slice 4: before running the target, recursively run + pin any un-pinned upstream
       *  (ancestor) nodes so a deep node is testable without pinning each one by hand. */
      autofillUpstream?: boolean;
    },
  ): Promise<
    { pure: true; output: unknown } | { pure: false; message: string }
  > {
    const found = await this.graphs.getLatestNamed(tenantId, workflowKey);
    if (!found) {
      throw new NotFoundException(`No graph saved for '${workflowKey}'`);
    }
    const node = found.graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new NotFoundException(`No node '${nodeId}' in this graph`);
    }
    if (UNTESTABLE_NODE_TYPES.has(node.type)) {
      return {
        pure: false,
        message: `"${node.type}" can't be tested in isolation — run the full flow.`,
      };
    }
    // mini-ctx: the workflow's pinned outputs, overridden by any manual inputs.
    const ctx = {
      ...(await this.pins.list(tenantId, workflowKey)),
      ...(body?.inputs ?? {}),
    };
    // Optionally run + pin un-pinned ancestors first (opt-in — can fan out into a partial run).
    if (body?.autofillUpstream) {
      await this.fillUpstream(
        tenantId,
        workflowKey,
        found.graph,
        node.id,
        ctx,
        new Set(),
      );
    }
    // Pure node: run in-process, instant, no Temporal.
    if (isPureNode(node.type)) {
      try {
        return { pure: true, output: runPureNode(node, ctx) };
      } catch (e) {
        throw new BadRequestException(
          e instanceof Error ? e.message : "Node failed to run",
        );
      }
    }
    // Activity node: run the REAL activity via a short-lived test-mode Temporal exec.
    try {
      const output = await this.executions.testNode(
        tenantId,
        workflowKey,
        node,
        ctx,
      );
      return { pure: true, output };
    } catch (e) {
      return {
        pure: false,
        message: `Test run failed: ${e instanceof Error ? e.message : "the node errored"}`,
      };
    }
  }

  /** Run one node against ctx (pure → in-process; activity → test-mode Temporal). */
  private runNode(
    tenantId: string,
    workflowKey: string,
    node: NodeDef,
    ctx: Record<string, unknown>,
  ): Promise<unknown> | unknown {
    return isPureNode(node.type)
      ? runPureNode(node, ctx)
      : this.executions.testNode(tenantId, workflowKey, node, ctx);
  }

  /**
   * Recursively ensure a node's testable ancestors are in `ctx` — walking edge predecessors, filling
   * each un-pinned one depth-first (its own ancestors first), running it, and persisting the result
   * as a pin. Cycle-guarded via `visiting`. Un-testable predecessors (triggers/wait/…) are left
   * empty; a predecessor that errors is skipped (the target then sees empty for it).
   */
  private async fillUpstream(
    tenantId: string,
    workflowKey: string,
    graph: GraphDef,
    nodeId: string,
    ctx: Record<string, unknown>,
    visiting: Set<string>,
  ): Promise<void> {
    const preds = graph.edges.filter((e) => e.to === nodeId).map((e) => e.from);
    for (const predId of preds) {
      if (predId in ctx || visiting.has(predId)) continue;
      const pred = graph.nodes.find((n) => n.id === predId);
      if (!pred || UNTESTABLE_NODE_TYPES.has(pred.type)) continue;
      visiting.add(predId);
      await this.fillUpstream(
        tenantId,
        workflowKey,
        graph,
        predId,
        ctx,
        visiting,
      );
      try {
        const out = await this.runNode(tenantId, workflowKey, pred, ctx);
        ctx[predId] = out;
        await this.pins.set(tenantId, workflowKey, predId, out);
      } catch {
        /* a failing ancestor stays absent — don't abort the whole fill */
      }
    }
  }

  @ApiEndpoint({
    summary: "List a workflow's pinned node outputs",
    description: "Returns `{ [nodeId]: output }` for the canvas to overlay.",
  })
  @Get("pins")
  list(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<Record<string, unknown>> {
    return this.pins.list(tenantId, workflowKey);
  }

  @ApiEndpoint({ summary: "Pin (or replace) a node's sample output" })
  @Put("nodes/:nodeId/pin")
  async set(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
    @Body() body: { output: unknown },
  ): Promise<{ pinned: true }> {
    await this.pins.set(tenantId, workflowKey, nodeId, body?.output);
    return { pinned: true };
  }

  @ApiEndpoint({ summary: "Clear a node's pin" })
  @Delete("nodes/:nodeId/pin")
  async clear(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
  ): Promise<{ cleared: boolean }> {
    return { cleared: await this.pins.clear(tenantId, workflowKey, nodeId) };
  }
}
