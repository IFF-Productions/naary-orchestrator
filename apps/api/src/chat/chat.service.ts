import { BadRequestException, Injectable } from "@nestjs/common";
import { type ChatEndpoint, getPrisma } from "@naary/db";
import { getBudget } from "@naary/usage";

/** A freshly registered chat — the path is the public URL to host/share. */
export interface RegisteredChat {
  chatId: string;
  /** Public path to host the chat page (host is deployment-specific). */
  chatPath: string;
}

/** Public view of a registered chat endpoint (management list). */
export interface ChatEndpointView {
  id: string;
  workflowId: string;
  createdAt: Date;
}

@Injectable()
export class ChatService {
  /**
   * Register a hosted chat for a workflow. Like a form there is no secret — the opaque `id` IS the
   * capability. And like a form it is a PUBLIC, anonymous surface that spends the tenant's BYOK LLM
   * budget per message, so registration REQUIRES a monthly spend cap (the per-LLM-call reservation
   * backstop). Same invariant as forms: budgets have no DELETE path.
   */
  async createEndpoint(
    tenantId: string,
    environmentId: string,
    workflowId: string,
  ): Promise<RegisteredChat> {
    // @IsNotEmpty() treats "   " as non-empty; trim + reject so we never register a chat whose
    // workflowId can't resolve a graph (an unusable public endpoint).
    const key = workflowId.trim();
    if (!key) throw new BadRequestException("workflowId is required");
    const budget = await getBudget(tenantId);
    if (!budget) {
      throw new BadRequestException(
        "Set a monthly budget for this tenant before exposing a public chat — " +
          "an anonymous endpoint needs a spend cap.",
      );
    }
    const row = await getPrisma().chatEndpoint.create({
      data: { tenantId, environmentId, workflowId: key },
    });
    return { chatId: row.id, chatPath: `/c/${row.id}` };
  }

  /** List the tenant's chat endpoints (newest first). */
  list(tenantId: string): Promise<ChatEndpointView[]> {
    return getPrisma().chatEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, workflowId: true, createdAt: true },
    });
  }

  /** Delete a tenant's chat endpoint by id (tenant-scoped). Returns true if a row was removed. */
  async deleteEndpoint(tenantId: string, chatId: string): Promise<boolean> {
    const res = await getPrisma().chatEndpoint.deleteMany({
      where: { id: chatId, tenantId },
    });
    return res.count > 0;
  }

  getEndpoint(chatId: string): Promise<ChatEndpoint | null> {
    return getPrisma().chatEndpoint.findUnique({ where: { id: chatId } });
  }

  /** Load the last `limit` MESSAGES (rows, not turns — a turn is two rows) of a session's
   *  conversation, oldest-first, to thread into the next run's input so the agent has memory
   *  (design §2.1b option B). Ordered by the monotonic `seq` so it's deterministic even when two
   *  rows share a millisecond. Empty for a new session. Default 40 rows ≈ 20 turns. */
  async loadHistory(
    tenantId: string,
    chatId: string,
    sessionId: string,
    limit = 40,
  ): Promise<{ role: string; text: string }[]> {
    if (!sessionId) return [];
    const rows = await getPrisma().chatMessage.findMany({
      where: { tenantId, chatId, sessionId },
      orderBy: { seq: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: { role: true, text: true },
    });
    return rows.reverse(); // desc fetch (newest N) → return oldest-first
  }

  /** Persist a completed turn (user message + the assistant reply) ATOMICALLY — both rows or
   *  neither, so a failed second insert can't leave a half-turn. The user row is created first so
   *  its `seq` sorts before the reply. No-op without a session. */
  async appendTurn(
    tenantId: string,
    chatId: string,
    sessionId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    if (!sessionId) return;
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.chatMessage.create({
        data: { tenantId, chatId, sessionId, role: "user", text: userText },
      }),
      prisma.chatMessage.create({
        data: {
          tenantId,
          chatId,
          sessionId,
          role: "assistant",
          text: assistantText,
        },
      }),
    ]);
  }
}
