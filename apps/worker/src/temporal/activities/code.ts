// code node — user JavaScript in a QuickJS/WASM sandbox.
import { ApplicationFailure } from "@temporalio/activity";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { CodeNodeConfig } from "@naary/dsl";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import { activityDuration, activityRuns, secondsSince } from "../../metrics";
import type { AgentMeta } from "./shared";

export interface CodeInput {
  input: unknown;
  ctx: Record<string, unknown>;
}
export interface CodeResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

const DEFAULT_CODE_TIMEOUT_MS = 2000;
const MAX_CODE_TIMEOUT_MS = 5000;
const DEFAULT_CODE_MEM_MB = 64;
const MAX_CODE_MEM_MB = 128;

// The QuickJS/WASM module is loaded once per worker process (the WASM compile is
// expensive). Memoized promise — safe under concurrent activities.
let __qjsPromise: ReturnType<typeof getQuickJS> | undefined;
function getQjs(): ReturnType<typeof getQuickJS> {
  return (__qjsPromise ??= getQuickJS());
}
// Test seam.
export const __codeDeps = { getQjs };

/** JSON for embedding as a JS literal in the guest source — escape the line
 *  separators JSON.stringify leaves raw (valid JSON, historically invalid JS). */
function jsonForSource(v: unknown): string {
  // U+2028/U+2029 are valid in JSON strings but broke JS string literals pre-ES2019;
  // escape them. Built via new RegExp so no raw line-separator sits in this file.
  return JSON.stringify(v ?? null)
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

/**
 * code node — run user JavaScript in a QuickJS/WASM sandbox. No host access
 * (process/require/fetch are undefined in the guest); memory + wall-clock capped;
 * the runtime is always disposed. The code runs as `(function($input,$ctx){…})(…)`
 * and its return value becomes the node output. User-code failures are
 * non-retryable (the user must fix the code) — CODE_TIMEOUT for a deadline/OOM
 * interrupt, CODE_ERROR otherwise; only the guest error message is surfaced.
 */
export async function callCode(
  cfg: CodeNodeConfig,
  input: CodeInput,
  meta: AgentMeta,
): Promise<CodeResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  // Rehydrate any claim-checked upstream value BEFORE the sandbox sees it.
  const rehydrated = (await resolveClaimChecks(input, store)) as CodeInput;
  const QuickJS = await __codeDeps.getQjs();
  const runtime = QuickJS.newRuntime();
  const timeoutMs = Math.min(
    cfg.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
    MAX_CODE_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  try {
    runtime.setMemoryLimit(
      Math.min(cfg.memoryMb ?? DEFAULT_CODE_MEM_MB, MAX_CODE_MEM_MB) *
        1024 *
        1024,
    );
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const context = runtime.newContext();
    try {
      const src = `(function($input,$ctx){\n${cfg.code}\n})(${jsonForSource(
        rehydrated.input,
      )},${jsonForSource(rehydrated.ctx)})`;
      const res = context.evalCode(src);
      if (res.error) {
        const dumped = context.dump(res.error) as { message?: string } | string;
        res.error.dispose();
        const message =
          (typeof dumped === "object" ? dumped.message : String(dumped)) ||
          "code error";
        // A deadline/OOM interrupt vs a genuine user error.
        const interrupted = Date.now() >= deadline;
        activityRuns.inc({ activity: "callCode", outcome: "error" });
        activityDuration.observe(
          { activity: "callCode" },
          secondsSince(startedAt),
        );
        throw ApplicationFailure.nonRetryable(
          interrupted
            ? `Code timed out or exceeded memory after ${timeoutMs}ms`
            : `Code error: ${message.slice(0, 300)}`,
          interrupted ? "CODE_TIMEOUT" : "CODE_ERROR",
        );
      }
      const result = context.dump(res.value);
      res.value.dispose();
      // Offload a large return value so it can't blow the Temporal payload cap.
      const offloaded = await maybeOffload(result, store, {
        keyPrefix: `code/${meta.tenantId}`,
      });
      activityRuns.inc({ activity: "callCode", outcome: "ok" });
      activityDuration.observe(
        { activity: "callCode" },
        secondsSince(startedAt),
      );
      return { status: "ok", result: offloaded, costUsd: 0 };
    } finally {
      context.dispose();
    }
  } catch (e) {
    if (e instanceof ApplicationFailure) throw e;
    // Host-side failure (module load, marshalling) — sanitized, non-retryable.
    activityRuns.inc({ activity: "callCode", outcome: "error" });
    activityDuration.observe({ activity: "callCode" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable(
      "Code execution failed to run",
      "CODE_ERROR",
    );
  } finally {
    runtime.dispose();
  }
}
