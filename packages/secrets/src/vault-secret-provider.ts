import {
  type CredentialRef,
  DbSecretProvider,
  EXTERNAL_KEY_VERSION,
  type SecretProvider,
  type StoredMaterial,
  isExternalMaterial,
} from "./secret-provider";

/** Minimal `fetch` shape this adapter needs — injectable so tests never open a socket. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface VaultSecretProviderOptions {
  /** e.g. `https://vault.internal:8200`. Operator config — never tenant input. */
  addr: string;
  /** Vault token (periodic/AppRole-issued). Read from env, held in memory, never logged. */
  token: string;
  /** KV v2 mount point. Default `secret`. */
  mount?: string;
  /** Path prefix under the mount. Default `naary`. */
  prefix?: string;
  /** Vault Enterprise namespace (`X-Vault-Namespace`), if any. */
  namespace?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /**
   * Where to read rows this provider did NOT write (keyVersion 1/2/3). Defaults to the
   * DB provider, which is what makes flipping `SECRET_PROVIDER=vault` on an existing
   * instance safe: old rows keep resolving, new saves land in Vault.
   */
  fallback?: SecretProvider;
}

/**
 * Thrown for any non-2xx Vault response. Carries the STATUS ONLY — never the response
 * body, never the Vault token, never the secret. A Vault 403 body echoes the request path
 * and can include policy detail; an error thrown from inside `getDecryptedKey` is
 * serialized into Temporal history + worker logs by the activity's failure path (and
 * `toSanitizedRetryable` only keeps a duck-typed `statusCode`), so scrubbing has to happen
 * HERE, at construction — not at the boundary. (CLAUDE.md Tier-1 §4.)
 */
export class VaultRequestError extends Error {
  constructor(
    readonly statusCode: number,
    operation: string,
  ) {
    super(`Vault ${operation} failed (status ${statusCode})`);
    this.name = "VaultRequestError";
  }
}

/** Path segments come from ids we generate, but encode + reject separators defensively so
 *  no ref can ever escape the tenant's subtree of the KV mount. */
function segment(value: string, field: string): string {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`Invalid ${field} for a secret path`);
  }
  return encodeURIComponent(value);
}

/**
 * HashiCorp Vault KV v2 adapter (#458). Written against Vault's documented KV v2 HTTP
 * API using plain `fetch` — no new dependency, and the same shape AWS Secrets Manager
 * would slot into (one class, three methods, same contract test).
 *
 * NOT VERIFIED AGAINST A REAL VAULT SERVER. Its wire protocol (paths, method, KV v2
 * `data.data` envelope, `X-Vault-Token` header, 404 = absent) is covered by
 * `test/vault-secret-provider.spec.ts` with a stub `fetch`; no Vault instance was
 * contacted. Treat the first deployment against a live Vault as the remaining
 * verification step.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly name = "vault";
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly prefix: string;
  private readonly namespace?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly fallback: SecretProvider;

  constructor(opts: VaultSecretProviderOptions) {
    if (!opts.addr)
      throw new Error("VAULT_ADDR is required for SECRET_PROVIDER=vault");
    if (!opts.token)
      throw new Error("VAULT_TOKEN is required for SECRET_PROVIDER=vault");
    this.addr = opts.addr.replace(/\/+$/, "");
    this.token = opts.token;
    this.mount = opts.mount ?? "secret";
    this.prefix = opts.prefix ?? "naary";
    this.namespace = opts.namespace;
    // `?? 5_000` alone is not enough: NaN is not nullish, so a NaN here would survive and
    // make AbortSignal.timeout abort instantly on every request. Env values are validated by
    // parseTimeoutMs; this covers direct programmatic construction.
    this.timeoutMs =
      opts.timeoutMs !== undefined &&
      Number.isFinite(opts.timeoutMs) &&
      opts.timeoutMs > 0
        ? opts.timeoutMs
        : 5_000;
    const f =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f)
      throw new Error(
        "No fetch implementation available for VaultSecretProvider",
      );
    this.fetchImpl = f;
    this.fallback = opts.fallback ?? new DbSecretProvider();
  }

  /** `<prefix>/<tenantId>/<environmentId>/<provider>` — tenant-first so a Vault policy can
   *  scope a token to one tenant's subtree. */
  private path(ref: CredentialRef): string {
    return [
      this.prefix,
      segment(ref.tenantId, "tenantId"),
      segment(ref.environmentId, "environmentId"),
      segment(ref.provider, "provider"),
    ].join("/");
  }

  private url(kind: "data" | "metadata", ref: CredentialRef): string {
    return `${this.addr}/v1/${this.mount}/${kind}/${this.path(ref)}`;
  }

  private headers(): Record<string, string> {
    return {
      "X-Vault-Token": this.token,
      "Content-Type": "application/json",
      ...(this.namespace ? { "X-Vault-Namespace": this.namespace } : {}),
    };
  }

  private async request(
    method: string,
    url: string,
    operation: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // A transport error's message can contain the URL (which contains the tenant path)
      // but never the token or the secret; still, normalise it so no library-specific
      // field (headers, request body) can be serialized downstream.
      throw new Error(
        `Vault ${operation} failed: ${err instanceof Error ? err.name : "network error"}`,
      );
    }
    return res;
  }

  async put(ref: CredentialRef, plaintext: string): Promise<StoredMaterial> {
    const res = await this.request("POST", this.url("data", ref), "write", {
      data: { value: plaintext },
    });
    if (!res.ok) throw new VaultRequestError(res.status, "write");
    // The material is in Vault; the index row records only the sentinel.
    return {
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: EXTERNAL_KEY_VERSION,
    };
  }

  async get(ref: CredentialRef, stored: StoredMaterial): Promise<string> {
    // Coexistence: a row this provider did not write is still DB ciphertext.
    if (!isExternalMaterial(stored.keyVersion)) {
      return this.fallback.get(ref, stored);
    }
    const res = await this.request("GET", this.url("data", ref), "read");
    if (!res.ok) throw new VaultRequestError(res.status, "read");
    const body = (await res.json()) as {
      data?: { data?: Record<string, unknown> | null };
    } | null;
    const value = body?.data?.data?.value;
    if (typeof value !== "string" || value.length === 0) {
      // Present-but-empty (or soft-deleted) is indistinguishable from missing for our
      // purposes, and an empty key must never reach a provider call.
      throw new Error(
        `Vault has no value for credential '${ref.provider}' (tenant secret path missing or deleted)`,
      );
    }
    return value;
  }

  async remove(ref: CredentialRef): Promise<void> {
    // `metadata` (not `data`) destroys every version — a soft-deleted secret would still
    // be recoverable, which is not what "the tenant removed this key" should mean.
    const res = await this.request(
      "DELETE",
      this.url("metadata", ref),
      "delete",
    );
    // 404 = already gone: `remove` is idempotent (contract rule 5).
    if (!res.ok && res.status !== 404) {
      throw new VaultRequestError(res.status, "delete");
    }
  }
}

/**
 * Build the process's provider from env. LAZY BY CONTRACT: call this from a constructor /
 * first use, never at module scope — `CredentialsService` / `SecretStore` are constructed
 * lazily precisely so importing a module doesn't demand `ENCRYPTION_KEY` (see
 * `apps/worker/src/temporal/activities/shared.ts`), and the same must hold for
 * `VAULT_ADDR` / `VAULT_TOKEN`.
 *
 * Fails CLOSED: an unknown `SECRET_PROVIDER`, or `vault` without addr+token, throws
 * rather than silently falling back to the DB (a silent fallback would write material
 * somewhere the operator believes it is not).
 */
/**
 * Parse VAULT_TIMEOUT_MS, or THROW. A bad value must not be silently tolerated: `Number("30s")`
 * is NaN, NaN is not nullish so it defeated the `?? 5000` default, and `AbortSignal.timeout(NaN)`
 * aborts immediately — turning every secret read into an instant failure while the config looks
 * fine. This provider's whole contract is to fail closed AT BOOT (see assertSecretProviderConfig),
 * so a typo becomes a startup error naming the variable, not a mystery outage.
 */
function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined; // unset ⇒ the 5s default
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `VAULT_TIMEOUT_MS must be a positive number of milliseconds (got '${raw}')`,
    );
  }
  return n;
}

export function createSecretProvider(
  env: Record<string, string | undefined> = process.env,
): SecretProvider {
  const kind = (env.SECRET_PROVIDER ?? "db").trim().toLowerCase();
  if (kind === "" || kind === "db" || kind === "postgres") {
    return new DbSecretProvider();
  }
  if (kind === "vault") {
    return new VaultSecretProvider({
      addr: env.VAULT_ADDR ?? "",
      token: env.VAULT_TOKEN ?? "",
      mount: env.VAULT_KV_MOUNT || undefined,
      prefix: env.VAULT_PATH_PREFIX || undefined,
      namespace: env.VAULT_NAMESPACE || undefined,
      timeoutMs: parseTimeoutMs(env.VAULT_TIMEOUT_MS),
    });
  }
  throw new Error(
    `Unsupported SECRET_PROVIDER '${kind}'. Supported: db (default), vault.`,
  );
}

/**
 * Boot-time config gate. Constructing a provider is cheap and side-effect-free, so doing
 * it once at startup turns "SECRET_PROVIDER=vault but no VAULT_TOKEN" into a boot failure
 * instead of a mid-run credential resolution failure (a burned Temporal retry) — the same
 * reasoning as the existing `createKeyEncryptor()` call in the worker's `run()` and the
 * api's SecretsModule factory. Returns the provider NAME so callers can log the mode
 * (never any material or token).
 */
export function assertSecretProviderConfig(
  env: Record<string, string | undefined> = process.env,
): string {
  return createSecretProvider(env).name;
}
