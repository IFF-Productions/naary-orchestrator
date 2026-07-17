// mapNode — batched per-item fan-out over the "each"-capable activity fns.
import { ApplicationFailure } from "@temporalio/activity";
import type { AgentMeta } from "./shared";
import { type AgentConfig, runAgent } from "./agent";
import { type HttpRequestConfig, callHttpRequest } from "./http";
import { type McpToolConfig, callMcpTool } from "./mcp";

// ─────────────────────────────────────────────────────────────────────────────
// Items model A3 (design docs/design/ITEMS-MODEL-CURRENT-ITEM.md §0.3): batched map.
// ─────────────────────────────────────────────────────────────────────────────

/** One per-item call: the ALREADY-RESOLVED config the interpreter built against frame `i` (the same
 *  payload execNode passes for a single call) + that item's `input` (the current item). */
export interface MapNodeItem {
  cfg: unknown;
  input: unknown;
}

export interface MapNodeResult {
  /** One output per item, in order — the node's normal output shape, or `{ error }` for a failed
   *  item (mapNode never throws for an item; the workflow applies the node's onError). */
  outputs: unknown[];
  /** Sum of the completed items' costUsd — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/** Swappable seam so unit tests + the interpreter e2e can fake the per-item calls (mapNode loops
 *  the SAME activity fns execNode uses, so each records its own usage row per item — fail-safe). */
export const __mapDeps = {
  runAgent,
  callHttpRequest,
  callMcpTool,
};

const MAP_NODE_DEFAULT_CONCURRENCY = 10;

/**
 * Fan a single "each" activity node out over N per-item inputs in ONE Temporal activity — never one
 * activity per item (that would grow event history O(items)). It loops the underlying activity fns,
 * each of which records its OWN usage row as it completes, so a mid-batch failure leaves completed
 * items already billed (fail-safe, Tier-1 #6). Per-item errors are CAUGHT and returned as `{ error }`
 * (never rethrown) so a bad item can't trigger a whole-batch Temporal retry (which would re-charge +
 * duplicate POST/email); the mapNode proxy is configured `maxAttempts: 1` for the same reason.
 */
export async function mapNode(
  nodeType: string,
  items: MapNodeItem[],
  meta: AgentMeta,
  maxParallel: number = MAP_NODE_DEFAULT_CONCURRENCY,
): Promise<MapNodeResult> {
  const outputs: unknown[] = new Array(items.length);
  let costUsd = 0;

  const runOne = async (item: MapNodeItem, i: number): Promise<void> => {
    try {
      if (nodeType === "agent") {
        const r = await __mapDeps.runAgent(
          item.cfg as AgentConfig,
          item.input,
          meta,
        );
        outputs[i] = r;
        costUsd += r.costUsd; // single-threaded: read-modify-write is uninterrupted (no await between)
      } else if (nodeType === "httpRequest") {
        const r = await __mapDeps.callHttpRequest(
          item.cfg as HttpRequestConfig,
          item.input,
          meta,
        );
        outputs[i] = { status: r.httpStatus, headers: r.headers, body: r.body };
        costUsd += r.costUsd;
      } else if (nodeType === "mcpTool") {
        const r = await __mapDeps.callMcpTool(
          item.cfg as McpToolConfig,
          item.input,
          meta,
        );
        outputs[i] = r;
        costUsd += r.costUsd;
      } else {
        throw ApplicationFailure.nonRetryable(
          `mapNode: unsupported node type '${nodeType}'`,
          "MAPNODE_TYPE",
        );
      }
    } catch (err) {
      // An unsupported type is a programming error → propagate (fail the node). Any other per-item
      // failure is returned as { error } so it never triggers a whole-batch retry.
      if (err instanceof ApplicationFailure && err.type === "MAPNODE_TYPE") {
        throw err;
      }
      // Cap the per-item message (× N items enters history — keep the payload bounded).
      const raw = err instanceof Error ? err.message : String(err);
      outputs[i] = {
        error: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw,
      };
    }
  };

  // Bounded-concurrency pool over the N items. Result order is by index (deterministic to the
  // workflow — only mapNode's single return value enters history).
  let next = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const i = next++;
        await runOne(items[i], i);
      }
    }),
  );
  return { outputs, costUsd };
}
