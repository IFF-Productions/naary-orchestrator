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
  offloadCtxEntry,
} from "../src/temporal/activities/items";
import {
  CAN_CTX_BUDGET_BYTES,
  CAN_CTX_ENTRY_FLOOR_BYTES,
  CAN_CTX_MAX_OFFLOADABLE_ENTRY_BYTES,
  containsClaimCheckRef,
  planCtxOffload,
} from "../src/temporal/workflow/helpers";

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

/**
 * continueAsNew snapshot offload (#681). Same two halves as above: a PURE workflow-side planner
 * (legal in the deterministic interpreter) and the ACTIVITY that does the object-store PUT.
 */
describe("planCtxOffload (pure — safe in workflow code)", () => {
  /** A ctx entry of roughly `bytes` serialized size. */
  const entry = (bytes: number) => ({ blob: "x".repeat(bytes) });

  it("plans NOTHING for a ctx that already fits the budget (the ordinary run's byte-identical path)", () => {
    expect(planCtxOffload({ __input: { a: 1 }, n1: { ok: true } })).toEqual([]);
    // Even a single large-but-affordable output stays inline.
    expect(planCtxOffload({ n1: entry(500_000) })).toEqual([]);
  });

  it("offloads LARGEST-first and stops as soon as the snapshot fits (minimum readability loss)", () => {
    // ~1.9MB total, budget 1.2MB: offloading the single biggest already brings it to ~1.0MB, so the
    // plan STOPS there — `big`/`mid`/`small` stay inline and readable in workflow code.
    expect(
      planCtxOffload({
        small: entry(1_000),
        mid: entry(300_000),
        big: entry(700_000),
        huge: entry(900_000),
      }),
    ).toEqual(["huge"]);
    // Two are needed only when one is not enough (~2.4MB → 1.5MB → 1.0MB).
    expect(
      planCtxOffload({
        big: entry(700_000),
        bigger: entry(800_000),
        huge: entry(900_000),
      }),
    ).toEqual(["huge", "bigger"]);
  });

  it("is deterministic for equal-sized entries (node id tie-break, never insertion order)", () => {
    const a = planCtxOffload({ b: entry(700_000), a: entry(700_000) });
    const b = planCtxOffload({ a: entry(700_000), b: entry(700_000) });
    expect(a).toEqual(b);
    expect(a[0]).toBe("a");
  });

  it("never offloads reserved keys — `__*` bookkeeping and `$vars` (expressions read them constantly)", () => {
    const plan = planCtxOffload({
      __input: entry(700_000),
      $vars: entry(700_000),
      n1: entry(700_000),
    });
    expect(plan).toEqual(["n1"]);
  });

  it("skips entries below the per-entry floor and above the offloadable ceiling (fails closed, visibly)", () => {
    const belowFloor = CAN_CTX_ENTRY_FLOOR_BYTES - 5_000;
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`n${i}`, entry(belowFloor)]),
    );
    // ~1.7MB of SMALL entries: over budget, but no single one is worth a reference — nothing to do
    // (the honest remaining limit, same as expandItems' many-small-items case).
    expect(planCtxOffload(many)).toEqual([]);
    // A single entry too large to even pass to the offload activity is skipped, not attempted.
    expect(
      planCtxOffload({ giant: entry(CAN_CTX_MAX_OFFLOADABLE_ENTRY_BYTES + 1) }),
    ).toEqual([]);
  });

  it("the budget it enforces is well under Temporal's ~2MB payload cap", () => {
    expect(CAN_CTX_BUDGET_BYTES).toBeLessThan(2_000_000);
  });
});

describe("offloadCtxEntry (activity)", () => {
  it("returns a small REFERENCE that still resolves to the original value", async () => {
    const store = useStore();
    const value = { body: "y".repeat(200_000) };
    const ref = await offloadCtxEntry({ value }, META);
    expect(isClaimCheck(ref)).toBe(true);
    expect(JSON.stringify(ref).length).toBeLessThan(300); // references, not blobs
    expect(await resolveClaimChecks(ref, store)).toEqual(value);
  });
});
