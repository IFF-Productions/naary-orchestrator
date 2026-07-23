/**
 * Per-environment API calls for the Settings screen. Variables and env-secrets are
 * env-scoped server-side via the `X-Environment-Id` header (normally the ACTIVE env,
 * set globally by the client). The redesigned Settings shows ALL environments at once
 * (the variables matrix, secrets rows with env chips), so these helpers pin each
 * request to a specific environment by overriding that header — `http()` spreads
 * `init.headers` after the ambient ones, so the override wins.
 */
import type { TemplateBlock } from "@naary/dsl";
import { http } from "../../../lib/api/http";
import type { Variable } from "../../../lib/api";

/** A Form/Email content template (docs/design/TEMPLATE-EDITOR.md), as the API returns it. */
export interface ContentTemplate {
  id: string;
  kind: "email" | "form";
  name: string;
  subject: string | null;
  blocks: TemplateBlock[];
}

/** Create/update payload — everything but the id + scope. */
export interface ContentTemplateInput {
  kind: "email" | "form";
  name: string;
  subject?: string | null;
  blocks: TemplateBlock[];
}

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

  // Form/Email content templates (docs/design/TEMPLATE-EDITOR.md) — env-scoped block content a
  // sendEmail node renders. DISTINCT from the built-in workflow starter-templates (`/templates`).
  /** All content templates in ONE environment. */
  listTemplates(envId: string): Promise<ContentTemplate[]> {
    return http<ContentTemplate[]>(`/content-templates`, inEnv(envId));
  },
  /** Create a template in ONE environment. */
  createTemplate(
    envId: string,
    input: ContentTemplateInput,
  ): Promise<ContentTemplate> {
    return http<ContentTemplate>(`/content-templates`, {
      method: "POST",
      body: JSON.stringify(input),
      ...inEnv(envId),
    });
  },
  /** Update a template in ONE environment. */
  updateTemplate(
    envId: string,
    id: string,
    input: ContentTemplateInput,
  ): Promise<ContentTemplate> {
    return http<ContentTemplate>(
      `/content-templates/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
        ...inEnv(envId),
      },
    );
  },
  /** Delete a template from ONE environment (idempotent). */
  deleteTemplate(envId: string, id: string): Promise<void> {
    return http<void>(`/content-templates/${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...inEnv(envId),
    });
  },

  // Cloudflare Turnstile bot-protection config (docs/design/TURNSTILE-BOT-PROTECTION.md) — env-scoped.
  // The secret key is write-only: GET returns siteKey + enabled + hasSecret, never the secret.
  /** The env's Turnstile config, or null if none set. */
  getTurnstile(envId: string): Promise<TurnstileConfig | null> {
    return http<TurnstileConfig | null>(`/turnstile-config`, inEnv(envId));
  },
  /** Create/update the env's Turnstile config (secret key omitted ⇒ keep the existing one). */
  setTurnstile(
    envId: string,
    input: TurnstileConfigInput,
  ): Promise<TurnstileConfig> {
    return http<TurnstileConfig>(`/turnstile-config`, {
      method: "PUT",
      body: JSON.stringify(input),
      ...inEnv(envId),
    });
  },
  /** Remove the env's Turnstile config + its stored secret (idempotent). */
  deleteTurnstile(envId: string): Promise<void> {
    return http<void>(`/turnstile-config`, {
      method: "DELETE",
      ...inEnv(envId),
    });
  },
};

/** Public Turnstile config as the API returns it — never the secret key. */
export interface TurnstileConfig {
  siteKey: string;
  enabled: boolean;
  hasSecret: boolean;
}

/** Save payload — site key required; secret key write-only (omit to keep the existing one). */
export interface TurnstileConfigInput {
  siteKey: string;
  secretKey?: string;
  enabled: boolean;
}
