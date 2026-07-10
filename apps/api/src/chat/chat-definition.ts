/**
 * Pure (no NestJS / no I/O) chat-definition extraction + message validation for the hosted public
 * chat endpoint. Mirrors form-definition.ts. Unit-tested in test/chat-definition.spec.ts.
 *
 * A chat endpoint resolves to the tenant's CURRENT graph; this reads the graph's entry node — which
 * MUST be a `chatTrigger` — and exposes only a public view of its widget config (no tenant ids).
 */
import type { ChatTriggerNodeConfig, GraphDef } from "@naary/dsl";

/** Public view of a chat — safe to serve to an anonymous browser. Carries NO tenant/workflow ids. */
export interface ChatDefinition {
  chatId: string;
  title?: string;
  description?: string;
  placeholder?: string;
  greeting?: string;
}

/** A single chat message. Bounded so an anonymous caller can't push a megabyte into the run. */
export const MAX_MESSAGE_LENGTH = 10_000;

/**
 * Read the public chat definition from a graph. The graph's ENTRY node must be a `chatTrigger`
 * (a chat endpoint whose graph was later re-pointed is not a chat) — returns null otherwise so the
 * caller 404s. Re-projects to the known keys only (no unexpected config to the browser).
 */
export function extractChatDefinition(
  graph: GraphDef,
  chatId: string,
): ChatDefinition | null {
  const entry = graph.nodes.find((n) => n.id === graph.startNodeId);
  if (!entry || entry.type !== "chatTrigger") return null;
  const cfg = (entry.config ?? {}) as Partial<ChatTriggerNodeConfig>;
  return {
    chatId,
    ...(cfg.title ? { title: cfg.title } : {}),
    ...(cfg.description ? { description: cfg.description } : {}),
    ...(cfg.placeholder ? { placeholder: cfg.placeholder } : {}),
    ...(cfg.greeting ? { greeting: cfg.greeting } : {}),
  };
}

export type MessageResult =
  | { ok: true; message: string; sessionId: string }
  | { ok: false; error: string };

/**
 * Validate + sanitize an anonymous chat submission. Returns the sanitized `{ message, sessionId }`
 * that becomes the trigger input. `sessionId` (optional, caller-supplied) is bounded + coerced to a
 * string so it can key a future durable session; a missing one is fine (single-turn).
 */
export function validateMessage(body: unknown): MessageResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const message = input.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, error: "message is required" };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `message exceeds ${MAX_MESSAGE_LENGTH} characters`,
    };
  }
  const rawSession = input.sessionId;
  const sessionId =
    typeof rawSession === "string" && rawSession.length <= 200
      ? rawSession
      : "";
  return { ok: true, message, sessionId };
}
