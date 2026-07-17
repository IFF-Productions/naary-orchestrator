/**
 * Pure transforms for the OpenAPI import affordance (kept out of the .tsx so they're unit-testable
 * without a DOM). Given a parsed spec summary + a chosen operation, produce the partial httpRequest
 * node config to apply. No network, no React.
 */
import type { ApiOperation, OpenApiSummary } from "@naary/dsl";

export interface OpenApiImportConfig {
  method: string;
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Join a spec base URL with an operation path, tolerating trailing/leading slashes. A missing base
 *  URL yields the path alone (the user completes it). Never double-slashes the join. */
export function joinUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Build the httpRequest config for a picked operation: method + full URL, plus BLANK query/header
 * params so the user sees what the operation expects (values left empty — never invented). Path
 * params stay as `{id}` placeholders inside the URL; a declared body is not pre-filled here.
 */
export function toConfig(
  summary: OpenApiSummary,
  op: ApiOperation,
): OpenApiImportConfig {
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    if (p.in === "query") query[p.name] = "";
    else if (p.in === "header") headers[p.name] = "";
  }
  return {
    method: op.method,
    url: joinUrl(summary.baseUrl, op.path),
    ...(Object.keys(query).length ? { query } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}
