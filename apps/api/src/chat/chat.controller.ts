import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { extractChatDefinition, validateMessage } from "./chat-definition";
import { ChatService } from "./chat.service";

/**
 * PUBLIC chat ingress. Anonymous — the opaque `chatId` is the only capability (same posture as the
 * form endpoint). `GET` serves the widget definition (no tenant ids); `POST` runs the chat graph
 * with `{ message, sessionId }` and waits (bounded) for the graph's `respondToWebhook` reply. The
 * budget cap (required at registration) is the real cost backstop; the per-route @Throttle bounds
 * per-IP abuse. Single-turn for now — durable per-session conversation state is a later slice.
 */
@Public()
@Controller("chat")
export class ChatController {
  constructor(
    private readonly chats: ChatService,
    private readonly graphs: GraphsService,
    private readonly executions: ExecutionsService,
  ) {}

  /** Serve the public chat definition (title/greeting/…). 404 if unknown or the graph's entry
   *  node isn't a chatTrigger. */
  @Get(":chatId")
  async definition(@Param("chatId") chatId: string) {
    const { def } = await this.resolve(chatId);
    return def;
  }

  /** Accept a message: validate, run the chat graph, and return the graph's reply (synchronously,
   *  via the respondToWebhook mechanism). 200 with `{ status, reply? }`. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // 20 msgs / min / IP (per-IP; budget cap is the real backstop)
  @Post(":chatId")
  async message(@Param("chatId") chatId: string, @Body() body: unknown) {
    const { endpoint, snapshot } = await this.resolve(chatId);
    const result = validateMessage(body);
    if (!result.ok) throw new BadRequestException(result.error);
    // Cross-message memory (design §2.1b, B): load the session's history and thread it into the run
    // so the agent has context (bind an agent's prompt to `<chatTrigger>.history`).
    const history = await this.chats.loadHistory(
      endpoint.tenantId,
      chatId,
      result.sessionId,
    );
    const { response } = await this.executions.startChatAwaitResponse(
      endpoint.tenantId,
      snapshot,
      { message: result.message, sessionId: result.sessionId, history },
      endpoint.workflowId,
    );
    if (!response) return { status: "started" }; // ran but didn't reply in time — don't persist

    const reply = response.body ?? null;
    // Persist the turn so the next message sees it. Best-effort — a store hiccup must not fail the
    // reply the caller is waiting on.
    const replyText =
      typeof reply === "string"
        ? reply
        : reply == null
          ? ""
          : JSON.stringify(reply);
    await this.chats
      .appendTurn(
        endpoint.tenantId,
        chatId,
        result.sessionId,
        result.message,
        replyText,
      )
      .catch(() => undefined);
    // No workflowId leaked (it embeds the tenantId).
    return { status: "replied", reply };
  }

  /** Shared resolution: endpoint → current graph snapshot → public definition. 404 on any miss. */
  private async resolve(chatId: string) {
    const endpoint = await this.chats.getEndpoint(chatId);
    if (!endpoint) throw new NotFoundException("Unknown chat");
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.workflowId,
    );
    if (!snapshot) throw new NotFoundException("Unknown chat");
    const def = extractChatDefinition(snapshot.graph, chatId);
    if (!def) throw new NotFoundException("Unknown chat");
    return { endpoint, snapshot, def };
  }
}
