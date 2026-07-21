// The AI SDK (`ai`, `@ai-sdk/*`) is ESM-only; this file emits CommonJS, so static imports trip
// TS7's ESM/CJS guard. Load lazily via dynamic import() (the sanctioned CJS→ESM path).
const aiSdk = () => import("ai");
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { GEN_DEFAULT_MODEL, type GenProvider } from "./graph-generator.prompt";

/** Draft shape the model returns (loose; validateGraph + toGraphDef do the real checks). */
export interface GraphDraft {
  name?: string;
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: {
    from: string;
    to: string;
    condition?: { path: string; op: string; value?: unknown };
  }[];
}

/** Extract a graph object from the model's text: tolerate markdown fences / surrounding
 *  prose by taking the outermost {...}. Returns null if it isn't parseable graph-shaped JSON. */
export function parseGraphJson(text: string): GraphDraft | null {
  if (!text) return null;
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as unknown;
    if (
      !obj ||
      typeof obj !== "object" ||
      typeof (obj as GraphDraft).startNodeId !== "string" ||
      !Array.isArray((obj as GraphDraft).nodes) ||
      !Array.isArray((obj as GraphDraft).edges)
    ) {
      return null;
    }
    return obj as GraphDraft;
  } catch {
    return null;
  }
}

/** Safe, key-free one-line summary of a provider error for logs. */
export async function describeProviderError(e: unknown): Promise<string> {
  // Defensive import: `ai` is already cached (the generate call resolved it), but never let a
  // failed import in this error-describing helper mask the error we're trying to describe.
  const aiMod = await aiSdk().catch(() => undefined);
  if (aiMod?.APICallError.isInstance(e)) {
    const body =
      typeof e.responseBody === "string" ? e.responseBody.slice(0, 300) : "";
    return `APICallError status=${e.statusCode ?? "?"} url=${e.url ?? "?"} retryable=${e.isRetryable} msg=${e.message} body=${body}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Narrow the loose model output to a GraphDef (validateGraph does deep checks). */
export function toGraphDef(out: {
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: {
    from: string;
    to: string;
    condition?: { path: string; op: string; value?: unknown };
  }[];
}): GraphDef {
  return {
    startNodeId: out.startNodeId,
    nodes: out.nodes as GraphDef["nodes"],
    edges: out.edges as GraphDef["edges"],
  };
}

/** Map provider failures to HTTP responses (mirrors the worker's AUTH/QUOTA split). */
export async function mapProviderError(
  e: unknown,
  provider: string,
): Promise<HttpException> {
  // Defensive import: if `ai` can't load here (it's already cached from the generate call), don't
  // let that mask the provider error — fall through to the generic 503 below.
  const aiMod = await aiSdk().catch(() => undefined);
  if (aiMod?.APICallError.isInstance(e)) {
    const status = e.statusCode;
    if (status === 401 || status === 403) {
      return new BadRequestException(
        `Your ${provider} API key was rejected. Update it in Integrations.`,
      );
    }
    // Model renamed/removed → a 404 (or a 400 "model not found"). Actionable, not a
    // generic 503: the fix is to update the generator's model id, not "try again".
    if (
      status === 404 ||
      (status === 400 && /model/i.test(e.responseBody ?? ""))
    ) {
      return new UnprocessableEntityException(
        `The ${provider} model "${GEN_DEFAULT_MODEL[provider as GenProvider] ?? "?"}" is unavailable (it may have been renamed). Update the generator model id.`,
      );
    }
    // 429 = rate/quota; 529 = Anthropic "overloaded"; other 5xx = provider down.
    if (status === 429 || status === 529) {
      return new HttpException(
        `${provider} is rate-limited or overloaded. Try again shortly.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (typeof status === "number" && status >= 500) {
      return new ServiceUnavailableException(
        `${provider} is temporarily unavailable (upstream ${status}). Try again shortly.`,
      );
    }
  }
  return new ServiceUnavailableException(
    "The model couldn't generate a workflow right now. Try again.",
  );
}
