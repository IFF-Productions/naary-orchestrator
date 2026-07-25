// items — claim-check expansion of an offloaded items source (#479).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getByPath } from "@naary/dsl";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import type { AgentMeta } from "./shared";

const log = createLogger({ component: "worker" });

/**
 * Per-ELEMENT offload threshold for an expanded items array. Deliberately MUCH smaller than
 * {@link DEFAULT_CLAIM_CHECK_THRESHOLD} (1 MB, which is right for a SINGLE activity output): here we
 * return N values into one Temporal payload, so the per-element budget has to be the total budget
 * divided by a realistic N. At 8 KB, an array can hold ~125 inline elements before it approaches
 * {@link MAX_EXPANDED_ITEMS_BYTES} — and every element above 8 KB costs one small reference instead
 * of its full size, so "a few enormous items" (the case that used to hard-fail) now works.
 */
export const ITEM_CLAIM_CHECK_THRESHOLD = 8_000;

/**
 * Hard ceiling on the RETURNED array's serialized size — comfortably under Temporal's ~2MB payload
 * cap, since this array also has to survive being carried in `ctx` (and through continueAsNew).
 * Over it we fail closed with an actionable message: after per-element offload the only way to be
 * this big is MANY SMALL items, which no amount of offloading fixes (each would still need its own
 * reference in the payload) — that genuinely belongs in an upstream chunk or a `forEach` child run.
 */
export const MAX_EXPANDED_ITEMS_BYTES = 1_000_000;

export interface ExpandItemsConfig {
  /**
   * The upstream node's output EXACTLY as the workflow holds it. Small by construction — the big
   * parts are already `{__claimCheck}` references (that's why the workflow couldn't read it).
   */
  source: unknown;
  /** The splitOut/forEach `path` into that output — applied here with @naary/dsl's real getByPath. */
  path?: string;
}

/**
 * Expand a CLAIM-CHECKED items source into a real array the interpreter can iterate (#479).
 *
 * WHY AN ACTIVITY (CLAUDE.md Tier-1 rules 2 + 3): rehydrating a reference is object-storage I/O, so
 * it can never happen in workflow/graph-traversal code. The workflow detects "this source contains a
 * reference" with a pure shape check and delegates here; it only ever passes and receives small
 * references, never blobs.
 *
 * ORDER MATTERS: rehydrate FIRST, then walk the path. A reference can sit AT the source path
 * (`body` itself was offloaded) or ANYWHERE ABOVE it (`body.items`, where `body` is the reference and
 * a workflow-side getByPath silently yields `undefined` → zero items). Resolving first handles both
 * with one code path and no second path parser to drift from @naary/dsl's.
 *
 * Then each ELEMENT is re-offloaded above {@link ITEM_CLAIM_CHECK_THRESHOLD}, so the array the
 * workflow gets back is references-not-blobs. Those references are resolved again at the next
 * activity boundary (runAgent / callHttpRequest / callMcpTool / … all rehydrate their inputs).
 */
export async function expandItems(
  cfg: ExpandItemsConfig,
  meta: AgentMeta,
): Promise<unknown[]> {
  const store = getObjectStore();
  const resolved = await resolveClaimChecks(cfg.source, store);
  const raw = getByPath(resolved, cfg.path);
  // A missing/null source is a legitimate "no items" — same rule the interpreter applies inline.
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw ApplicationFailure.nonRetryable(
      "items source is not an array",
      "ITEMS_NOT_ARRAY",
    );
  }

  // Sequential, not Promise.all: each over-threshold element is an object-store PUT, and a
  // 10k-element array would otherwise open 10k concurrent uploads. The byte budget is enforced as we
  // GO so a pathological source fails fast instead of first materializing hundreds of MB.
  const items: unknown[] = new Array(raw.length);
  let bytes = 2; // the enclosing "[]"
  let offloaded = 0;
  for (let i = 0; i < raw.length; i++) {
    const el = await maybeOffload(raw[i], store, {
      keyPrefix: `items/${meta.tenantId}`,
      thresholdBytes: ITEM_CLAIM_CHECK_THRESHOLD,
    });
    if (el !== raw[i]) offloaded++;
    items[i] = el;
    bytes += Buffer.byteLength(JSON.stringify(el ?? null), "utf8") + 1; // +1 for the comma
    if (bytes > MAX_EXPANDED_ITEMS_BYTES) {
      throw ApplicationFailure.nonRetryable(
        `items source is too large to iterate: ${i + 1} of ${raw.length} items already exceed ${MAX_EXPANDED_ITEMS_BYTES} bytes after per-item offload — chunk upstream or use forEach`,
        "ITEMS_SOURCE_TOO_LARGE",
      );
    }
  }

  // Counts + bytes only — never the item values (same privacy posture as the rest of the worker).
  log.info(
    {
      activity: "expandItems",
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      tenantId: meta.tenantId,
      items: items.length,
      offloaded,
      bytes,
    },
    "expanded a claim-checked items source",
  );
  return items;
}
