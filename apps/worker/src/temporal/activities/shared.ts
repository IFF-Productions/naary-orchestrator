// Shared helpers for the activity domain modules: the worker logger, the lazy
// ESM SDK loaders, error sanitization, the common activity meta type, and the
// credential/secret-store accessors. Imports from NO sibling activity module
// (it is the dependency root — no circular imports).
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId } from "@naary/db";
import type { Logger } from "@naary/logging";
import { CredentialsService, SecretStore } from "@naary/secrets";

// The AI SDK (`ai`, `@ai-sdk/*`) and `jose` are ESM-only; this file is CommonJS (activities run
// under `node -r @swc/register`, which emits CJS), so a static import of an ESM-only dep trips the
// CJS→ESM boundary (and TS7's node16 guard). Load them lazily via dynamic import() — the sanctioned
// CJS→ESM path (already used for embeddings below). Activities aren't deterministic workflow code,
// so a per-call async import is fine.
export const aiSdk = () => import("ai");
export const anthropicSdk = () => import("@ai-sdk/anthropic");
export const openaiSdk = () => import("@ai-sdk/openai");
export const googleSdk = () => import("@ai-sdk/google");

/**
 * Sanitize a transient error before it leaves the activity. A thrown error is
 * serialized into Temporal history + worker logs; AI-SDK `APICallError` carries
 * `requestBodyValues` / URL / request headers that can include the `Authorization`
 * (provider key) header. We rethrow a fresh, RETRYABLE `ApplicationFailure` that
 * keeps only a status code + generic message — dropping every secret-bearing field —
 * so retryability is preserved (CLAUDE.md: don't burn retries; don't leak secrets).
 */
export function toSanitizedRetryable(
  e: unknown,
  type: string,
): ApplicationFailure {
  // Duck-type a status code (avoids importing the ESM-only `ai` in this sync path). This helper is
  // GENERIC — it wraps errors from every activity kind (agent, HTTP, MCP, integration, RSS, poll),
  // and many non-provider libs also attach a numeric `statusCode`, so the message stays neutral
  // ("Request failed") rather than claiming a provider fault. The status-specific 401/429 fast-fail
  // happens upstream; here we only surface the code + the activity `type` for debugging.
  const statusCode =
    typeof e === "object" &&
    e !== null &&
    typeof (e as { statusCode?: unknown }).statusCode === "number"
      ? (e as { statusCode: number }).statusCode
      : undefined;
  if (statusCode !== undefined) {
    return ApplicationFailure.retryable(
      `Request failed (status ${statusCode})`,
      type,
      { statusCode },
    );
  }
  // Non-provider transient (network blip, timeout): its message is safe, but wrap it
  // so any structured/secret-bearing fields on the original object are not serialized.
  const message = e instanceof Error ? e.message : "Transient activity error";
  return ApplicationFailure.retryable(message, type);
}

export interface AgentMeta {
  tenantId: string;
  /** The environment this run executes in (Slice 5b) — selects which env-scoped provider key the
   *  activity reads. Optional: a pre-5b run's ctx has none, so the activity falls back to the
   *  tenant's default env (byte-identical to pre-Slice-5 behavior). */
  environmentId?: string;
  executionId: string;
  nodeId: string;
  /** Per-run verbose logging (opt-in at start). When true, `runLog(base, meta)` returns a
   *  DEBUG-level child logger so this ONE run emits its `.debug()` lines while every other run stays
   *  at the process LOG_LEVEL. Non-secret flag, threaded through the run ctx → meta (Tier-1 §4). */
  debug?: boolean;
}

/**
 * Per-run debug logging. Returns a child of `base` that ALSO logs at DEBUG — but only when the run
 * was started with `debug` on; otherwise returns `base` unchanged (normal LOG_LEVEL). The child
 * carries the run's correlation ids so its extra lines are filterable by execution/node. Adopt as
 * `const rlog = runLog(log, meta)` and use `rlog.debug(...)` for detail that should appear only for a
 * debug run. Log ONLY safe metadata (ids, names, counts, sizes) — never args/prompts/values
 * (CLAUDE.md Tier-1 §4; the logger additionally scrubs every field).
 */
export function runLog(base: Logger, meta: AgentMeta): Logger {
  if (!meta.debug) return base;
  return base.child(
    {
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      tenantId: meta.tenantId,
    },
    { level: "debug" },
  );
}

// Constructed lazily so importing this module doesn't require ENCRYPTION_KEY
// until an agent actually runs.
let credentials: CredentialsService | undefined;
export function getCredentials(): CredentialsService {
  credentials ??= new CredentialsService();
  return credentials;
}

/** Crude char/4 token estimate — only used when the provider omits usage. */
export function estimateTokens(
  systemPrompt: string,
  input: unknown,
  outputText: string,
) {
  const inputChars = systemPrompt.length + JSON.stringify(input).length;
  return {
    inputTokens: Math.max(1, Math.ceil(inputChars / 4)),
    outputTokens: Math.max(1, Math.ceil(outputText.length / 4)),
  };
}

// Lazily built so merely importing this module doesn't require ENCRYPTION_KEY (the encryptor reads it
// at construction). Real activities build it on first use; tests swap `__httpDeps.getSecret`, so the
// store is never constructed under test.
let __secretStore: SecretStore | undefined;
export function getSecretStore(): SecretStore {
  __secretStore ??= new SecretStore();
  return __secretStore;
}

/**
 * A memoized, env-scoped `{{ $secrets.NAME }}` → plaintext resolver for use INSIDE an activity
 * (Tier-1 §4 — never in the workflow). `getSecret` is injected so each activity swaps its own test
 * seam. The run's env is resolved once (falling back to the tenant default for a pre-env run); each
 * distinct NAME is decrypted once; a missing secret is a non-retryable failure naming only the NAME.
 * Shared by httpRequest (headers + body) and mcpTool (arguments).
 */
export function makeSecretResolver(
  meta: AgentMeta,
  getSecret: (
    tenantId: string,
    environmentId: string,
    name: string,
  ) => Promise<string | null>,
): (name: string) => Promise<string> {
  let envIdPromise: Promise<string> | undefined;
  const cache = new Map<string, string>();
  return async (name: string): Promise<string> => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    envIdPromise ??= Promise.resolve(
      meta.environmentId ?? getDefaultEnvironmentId(meta.tenantId),
    );
    const environmentId = await envIdPromise;
    const value = await getSecret(meta.tenantId, environmentId, name);
    if (value == null) {
      throw ApplicationFailure.nonRetryable(
        `Missing environment secret "${name}" — add it under Settings → Secrets for this environment.`,
        "MISSING_SECRET",
      );
    }
    cache.set(name, value);
    return value;
  };
}
