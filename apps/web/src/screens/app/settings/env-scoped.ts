/**
 * Per-environment API calls for the Settings screen. Variables and env-secrets are
 * env-scoped server-side via the `X-Environment-Id` header (normally the ACTIVE env,
 * set globally by the client). The redesigned Settings shows ALL environments at once
 * (the variables matrix, secrets rows with env chips), so these helpers pin each
 * request to a specific environment by overriding that header — `http()` spreads
 * `init.headers` after the ambient ones, so the override wins.
 */
import { http } from "../../../lib/api/http";
import type { Variable } from "../../../lib/api";

function inEnv(envId: string): { headers: Record<string, string> } {
  return { headers: { "x-environment-id": envId } };
}

export const envScoped = {
  /** All variables of ONE environment ({ key, value } rows). */
  listVariables(envId: string): Promise<Variable[]> {
    return http<Variable[]>(`/variables`, inEnv(envId));
  },
  /** Create/overwrite one variable in ONE environment. */
  setVariable(envId: string, key: string, value: string): Promise<Variable> {
    return http<Variable>(`/variables/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
      ...inEnv(envId),
    });
  },
  /** Delete one variable from ONE environment (idempotent). */
  deleteVariable(envId: string, key: string): Promise<void> {
    return http<void>(`/variables/${encodeURIComponent(key)}`, {
      method: "DELETE",
      ...inEnv(envId),
    });
  },
  /** Secret NAMES of one environment — values are write-only and never returned. */
  listSecrets(envId: string): Promise<{ name: string }[]> {
    return http<{ name: string }[]>(`/env-secrets`, inEnv(envId));
  },
  /** Set/replace one secret's value in ONE environment (204). */
  setSecret(envId: string, name: string, value: string): Promise<void> {
    return http<void>(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
      ...inEnv(envId),
    });
  },
  /** Delete one secret from ONE environment (idempotent). */
  deleteSecret(envId: string, name: string): Promise<void> {
    return http<void>(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
      ...inEnv(envId),
    });
  },

  // Tenant-wide (global) secrets (#459) — apply to EVERY environment, so NO env header. An env-specific
  // secret of the same name overrides the global one at run time. Values stay write-only (names out).
  /** Tenant-wide secret NAMES (values are write-only, never returned). */
  listGlobalSecrets(): Promise<{ name: string }[]> {
    return http<{ name: string }[]>(`/env-secrets/global`);
  },
  /** Set/replace one tenant-wide secret's value (204). */
  setGlobalSecret(name: string, value: string): Promise<void> {
    return http<void>(`/env-secrets/global/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  /** Delete one tenant-wide secret (idempotent). */
  deleteGlobalSecret(name: string): Promise<void> {
    return http<void>(`/env-secrets/global/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },
};
