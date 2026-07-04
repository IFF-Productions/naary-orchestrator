import { getByPath } from "./mcp-args";
import type { RespondToWebhookNodeConfig } from "./types";

/** The concrete webhook response after binding resolution. Mirrors the contracts
 *  `WebhookResponse` shape (kept structural to avoid a dsl→contracts dep). */
export interface ResolvedWebhookResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Resolve a respondToWebhook node's response from ctx. Pure, deterministic
 * (path-read, no I/O). `bodyBinding` overrides the static `body`; status defaults
 * to 200. The base body is deep-cloned so a binding can't mutate the in-memory
 * graph definition (same guard as resolveHttpRequest).
 */
export function resolveWebhookResponse(
  config: RespondToWebhookNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedWebhookResponse {
  const body = config.bodyBinding
    ? getByPath(ctx[config.bodyBinding.from], config.bodyBinding.path)
    : config.body !== null && typeof config.body === "object"
      ? (JSON.parse(JSON.stringify(config.body)) as unknown)
      : config.body;
  return {
    statusCode: config.statusCode ?? 200,
    body,
    ...(config.headers ? { headers: config.headers } : {}),
  };
}
