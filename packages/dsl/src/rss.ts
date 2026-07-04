import { getByPath } from "./mcp-args";
import type { RssReadNodeConfig } from "./types";

/** The concrete rssRead request after binding resolution (no secrets). */
export interface ResolvedRss {
  url: string;
  timeoutMs?: number;
}

/**
 * Resolve an rssRead node's URL from ctx. Pure, deterministic (path-read, no I/O).
 * `urlBinding` overrides the static `url`.
 */
export function resolveRss(
  config: RssReadNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedRss {
  const bound = config.urlBinding
    ? getByPath(ctx[config.urlBinding.from], config.urlBinding.path)
    : undefined;
  return {
    url: typeof bound === "string" && bound ? bound : config.url,
    timeoutMs: config.timeoutMs,
  };
}
