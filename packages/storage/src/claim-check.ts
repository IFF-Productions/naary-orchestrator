import { randomUUID } from "node:crypto";
import type { ObjectStore } from "./object-store";

/**
 * Claim-check (Arch§4.6): large activity outputs are offloaded to object storage
 * and a small REFERENCE flows through Temporal instead — keeping payloads under
 * the ~2MB history cap. References are resolved transparently at the activity
 * boundary (where I/O is allowed), so the workflow only ever holds the reference.
 */
export interface ClaimCheck {
  __claimCheck: string; // opaque object-store reference
  bytes: number; // original serialized size
}

export function isClaimCheck(value: unknown): value is ClaimCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ClaimCheck).__claimCheck === "string"
  );
}

/** Default offload threshold — comfortably under Temporal's ~2MB payload cap. */
export const DEFAULT_CLAIM_CHECK_THRESHOLD = 1_000_000; // 1 MB

/**
 * Offload `value` to the store if its JSON serialization exceeds `thresholdBytes`,
 * returning a {@link ClaimCheck}; otherwise return the value unchanged (small
 * values stay inline, so existing small-payload flows are unaffected).
 */
export async function maybeOffload(
  value: unknown,
  store: ObjectStore,
  opts: { keyPrefix: string; thresholdBytes?: number },
): Promise<unknown> {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json, "utf8");
  const threshold = opts.thresholdBytes ?? DEFAULT_CLAIM_CHECK_THRESHOLD;
  if (bytes <= threshold) return value;
  const ref = await store.put(`${opts.keyPrefix}/${randomUUID()}.json`, json);
  return { __claimCheck: ref, bytes } satisfies ClaimCheck;
}

/** Deeply resolve any {@link ClaimCheck} references in `value` by fetching them. */
export async function resolveClaimChecks(
  value: unknown,
  store: ObjectStore,
): Promise<unknown> {
  if (isClaimCheck(value)) {
    const buf = await store.get(value.__claimCheck);
    return JSON.parse(buf.toString("utf8"));
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveClaimChecks(v, store)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await resolveClaimChecks(v, store);
    }
    return out;
  }
  return value;
}
