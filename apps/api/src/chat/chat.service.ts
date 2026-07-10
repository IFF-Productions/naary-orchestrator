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
    workflowId: string,
  ): Promise<RegisteredChat> {
    const budget = await getBudget(tenantId);
    if (!budget) {
      throw new BadRequestException(
        "Set a monthly budget for this tenant before exposing a public chat — " +
          "an anonymous endpoint needs a spend cap.",
      );
    }
    const row = await getPrisma().chatEndpoint.create({
      data: { tenantId, workflowId },
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
}
