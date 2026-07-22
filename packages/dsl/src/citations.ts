// RAG citations (issue #482): derive the "sources" a hosted-chat run used to answer from the run's
// vectorQuery node outputs. PURE + deterministic (a graph + ctx read, no I/O / clock / randomness),
// so it is safe to call from the deterministic interpreter (Tier-1 rule 2). Kept structural (no
// @naary/contracts dep, mirroring respond-webhook.ts) — the returned shape is byte-compatible with
// the contracts `Citation`.
import type { GraphDef } from "./types";

/** A privacy-safe RAG source: the collection it came from, a truncated snippet, and the score. */
export interface DerivedCitation {
  source?: string;
  snippet: string;
  score?: number;
}

/** vectorQuery writes `ctx[id] = { matches: [{ chunkText, score }] }` (see rag.ts callVectorQuery /
 *  data.ts handleVectorQuery). Read that shape back defensively — a node present in the graph but
 *  not run (or run with no matches) yields nothing. */
interface VectorQueryOutput {
  matches?: { chunkText?: unknown; score?: unknown }[];
}

/** Truncate a chunk to a bounded snippet so a large retrieved document never bloats the response. */
const SNIPPET_MAX = 500;
/** Cap total citations across all vectorQuery nodes — keep the chat response payload small. */
const MAX_CITATIONS = 20;

function toSnippet(text: string): string {
  const t = text.trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX)}…` : t;
}

/**
 * Collect the RAG sources a run retrieved, for the hosted chat's "Sources" list (issue #482).
 * Walks the GRAPH for `vectorQuery` nodes (precise — never a blind ctx scan that could mistake
 * another node's `matches`) and reads each one's output from `ctx`. Fails safe to `[]`: a graph
 * with no vectorQuery, a vectorQuery that didn't run, or one that matched nothing all yield no
 * citations — which is exactly the AC's "empty array when there's no RAG step".
 *
 * PRIVACY: the chunks are the SAME tenant's own indexed documents being returned to that tenant's
 * chat, so surfacing a truncated snippet + score to that chat is in-tenant. Callers must keep these
 * on the chat/webhook response only — never the usage ledger, telemetry, or persisted chat history.
 */
export function collectCitations(
  graph: GraphDef,
  ctx: Record<string, unknown>,
): DerivedCitation[] {
  const out: DerivedCitation[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "vectorQuery") continue;
    const result = ctx[node.id] as VectorQueryOutput | undefined;
    const matches = result?.matches;
    if (!Array.isArray(matches)) continue;
    // The node's `collection` config is the source ref — vectorQuery's per-chunk output carries no
    // source id/metadata (rag.ts returns only chunkText + score), so the collection is the best
    // honest provenance we have.
    const source =
      typeof node.config?.collection === "string"
        ? node.config.collection
        : undefined;
    for (const m of matches) {
      if (out.length >= MAX_CITATIONS) return out;
      if (typeof m?.chunkText !== "string" || m.chunkText.trim() === "")
        continue;
      out.push({
        ...(source !== undefined ? { source } : {}),
        snippet: toSnippet(m.chunkText),
        ...(typeof m.score === "number" ? { score: m.score } : {}),
      });
    }
  }
  return out;
}
