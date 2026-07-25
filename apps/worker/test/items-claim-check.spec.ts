import { describe, expect, it } from "vitest";
import {
  MemoryObjectStore,
  __setObjectStore,
  isClaimCheck,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import {
  ITEM_CLAIM_CHECK_THRESHOLD,
  MAX_EXPANDED_ITEMS_BYTES,
  expandItems,
} from "../src/temporal/activities/items";
import { containsClaimCheckRef } from "../src/temporal/workflow/helpers";

/**
 * Items claim-check offload (#479). Two halves:
 *   - `containsClaimCheckRef` — the PURE, workflow-side detector (no I/O, so it is legal in the
 *     deterministic interpreter). It decides whether the expandItems activity is needed at all.
 *   - `expandItems` — the ACTIVITY that rehydrates the source, applies the real getByPath, and
 *     re-offloads PER ELEMENT so the workflow gets back references, never blobs.
 */

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "sp" };

/** A fresh in-memory store per case, installed as the process-wide singleton the activity reads. */
function useStore(): MemoryObjectStore {
  const store = new MemoryObjectStore();
  __setObjectStore(store);
  return store;
}

/** Force an offload regardless of size, so a test can build a reference cheaply. */
async function toRef(
  value: unknown,
  store: MemoryObjectStore,
): Promise<unknown> {
  return maybeOffload(value, store, { keyPrefix: "test", thresholdBytes: 0 });
}

describe("containsClaimCheckRef (pure — safe in workflow code)", () => {
  it("detects a reference at the root, nested, and inside an array", async () => {
    const store = useStore();
    const ref = await toRef({ a: 1 }, store);
    expect(containsClaimCheckRef(ref)).toBe(true);
    expect(containsClaimCheckRef({ body: ref })).toBe(true);
    expect(containsClaimCheckRef({ deep: { list: [1, ref] } })).toBe(true);
  });

  it("is false for ordinary payloads (so the common path never calls the activity)", () => {
    expect(containsClaimCheckRef(undefined)).toBe(false);
    expect(containsClaimCheckRef(null)).toBe(false);
    expect(containsClaimCheckRef("a string")).toBe(false);
    expect(containsClaimCheckRef({ items: [{ n: 1 }, { n: 2 }] })).toBe(false);
    // A look-alike whose ref field isn't a string is NOT a claim check.
    expect(containsClaimCheckRef({ __claimCheck: 42 })).toBe(false);
  });

  it("is cycle-safe (a self-referencing ctx must not hang the workflow task)", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(() => containsClaimCheckRef(a)).not.toThrow();
    expect(containsClaimCheckRef(a)).toBe(false);
  });
});

describe("expandItems", () => {
  it("expands a reference sitting AT the source path", async () => {
    const store = useStore();
    const source = await toRef({ items: [{ n: 1 }, { n: 2 }] }, store);
    expect(await expandItems({ source, path: "items" }, META)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it("expands a reference sitting ABOVE the source path (the old SILENT zero-items case)", async () => {
    const store = useStore();
    // This is what an offloaded httpRequest body looks like in ctx: the ref is `body`, while the
    // splitOut path is `body.items`. A workflow-side getByPath yields undefined → 0 items, silently.
    const bodyRef = await toRef(
      { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
      store,
    );
    const source = { status: "ok", body: bodyRef };
    expect(await expandItems({ source, path: "body.items" }, META)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  it("passes REFERENCES, not blobs, for elements over the per-item threshold", async () => {
    const store = useStore();
    const big = "x".repeat(ITEM_CLAIM_CHECK_THRESHOLD + 1);
    const source = await toRef({ items: [{ big }, { small: "s" }] }, store);

    const items = await expandItems({ source, path: "items" }, META);

    expect(items).toHaveLength(2);
    // The oversized element became a small reference…
    expect(isClaimCheck(items[0])).toBe(true);
    // …that still resolves to the real value at the next activity boundary.
    expect(await resolveClaimChecks(items[0], store)).toEqual({ big });
    // …while a small element stays INLINE (so downstream `{{ sp.small }}` keeps working).
    expect(items[1]).toEqual({ small: "s" });
  });

  it("a missing/null source is 'no items', not an error", async () => {
    useStore();
    expect(await expandItems({ source: {}, path: "nope.items" }, META)).toEqual(
      [],
    );
    expect(await expandItems({ source: null }, META)).toEqual([]);
  });

  it("a DEFINED non-array source fails closed (a mis-binding, not an empty map)", async () => {
    const store = useStore();
    const source = await toRef({ items: { not: "an array" } }, store);
    await expect(expandItems({ source, path: "items" }, META)).rejects.toThrow(
      /not an array/,
    );
  });

  it("MANY SMALL items still fail closed — offloading each cannot shrink the payload", async () => {
    const store = useStore();
    // Each item is under the per-item threshold, so nothing gets offloaded; the array as a whole
    // blows the budget. That is the honest remaining limit: it needs an upstream chunk / forEach.
    const per = 1_000;
    const count = Math.ceil(MAX_EXPANDED_ITEMS_BYTES / per) + 10;
    const items = Array.from({ length: count }, () => ({
      s: "y".repeat(per),
    }));
    const source = await toRef({ items }, store);
    await expect(expandItems({ source, path: "items" }, META)).rejects.toThrow(
      /too large to iterate/,
    );
  });
});
