import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { TurnstileConfigService } from "../turnstile/turnstile-config.service";
import {
  extractChatDefinition,
  isDurableSession,
  validateMessage,
} from "./chat-definition";
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
    private readonly turnstile: TurnstileConfigService,
  ) {}

  /** Serve the public chat definition (title/greeting/…). 404 if unknown or the graph's entry
   *  node isn't a chatTrigger. Includes `turnstileSiteKey` when the tenant has an active bot gate
   *  for this env (so the widget renders). */
  @Get(":chatId")
  async definition(@Param("chatId") chatId: string) {
    const { endpoint, def } = await this.resolve(chatId);
    const turnstileSiteKey = await this.turnstile.publicSiteKey(
      endpoint.tenantId,
      endpoint.environmentId,
    );
    return turnstileSiteKey ? { ...def, turnstileSiteKey } : def;
  }

  /** Accept a message: verify the Turnstile challenge (if the tenant enabled it), validate, run the
   *  chat graph, and return the graph's reply (synchronously, via the respondToWebhook mechanism).
   *  200 with `{ status, reply? }`. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // 20 msgs / min / IP (per-IP; budget cap is the real backstop)
  @Post(":chatId")
  async message(
    @Param("chatId") chatId: string,
    @Body() body: { turnstileToken?: unknown } & Record<string, unknown>,
  ) {
    const { endpoint, snapshot } = await this.resolve(chatId);
    // Bot gate ABOVE the durable/per-message fork — both paths spend budget, so gate once. Every
    // message needs its own solved (single-use) token. validateMessage ignores turnstileToken.
    const token =
      typeof body?.turnstileToken === "string"
        ? body.turnstileToken
        : undefined;
    const allowed = await this.turnstile.verify(
      endpoint.tenantId,
      endpoint.environmentId,
      token,
    );
    if (!allowed) {
      throw new ForbiddenException("Bot verification failed — please retry.");
    }
    const result = validateMessage(body);
    if (!result.ok) throw new BadRequestException(result.error);

    // Durable per-session mode (design §2.1b, option A): the chatTrigger opted in AND we have a
    // session to key on. The long-lived chatSession workflow owns memory + persistence (it seeds
    // from and appends to the ChatMessage table), so the controller just signals + waits. Without a
    // sessionId there's nothing to key a session on, so fall through to the per-message path (B).
    if (result.sessionId && isDurableSession(snapshot.graph)) {
      const { replied, reply, citations } =
        await this.executions.sendChatSessionMessage(
          endpoint.tenantId,
          endpoint.environmentId,
          snapshot,
          {
            message: result.message,
            sessionId: result.sessionId,
            chatId,
          },
          endpoint.workflowId,
        );
      // citations[] = the RAG sources the turn retrieved (issue #482); [] when the turn ran no
      // vectorQuery, so the chat UI can always read a "Sources" array (empty ⇒ no sources shown).
      return replied
        ? { status: "replied", reply, citations: citations ?? [] }
        : { status: "started", citations: [] };
    }

    // Cross-message memory (design §2.1b, B): load the session's history and thread it into the run
    // so the agent has context (bind an agent's prompt to `<chatTrigger>.history`).
    const history = await this.chats.loadHistory(
      endpoint.tenantId,
      chatId,
      result.sessionId,
    );
    const { response } = await this.executions.startChatAwaitResponse(
      endpoint.tenantId,
      endpoint.environmentId,
      snapshot,
      { message: result.message, sessionId: result.sessionId, history },
      endpoint.workflowId,
    );
    if (!response) return { status: "started", citations: [] }; // ran but didn't reply in time — don't persist

    const reply = response.body ?? null;
    // Persist the turn so the next message sees it. Best-effort — a store hiccup must not fail the
    // reply the caller is waiting on. `stringify` is guarded because a circular/BigInt reply body
    // would otherwise throw here and sink an otherwise-successful reply.
    const replyText = stringifyReply(reply);
    await this.chats
      .appendTurn(
        endpoint.tenantId,
        chatId,
        result.sessionId,
        result.message,
        replyText,
      )
      .catch(() => undefined);
    // No workflowId leaked (it embeds the tenantId). citations[] = the run's RAG sources (issue
    // #482) — [] when the graph ran no vectorQuery. Scoped to THIS chat response only; never
    // persisted to the ChatMessage history (appendTurn stores reply text only).
    return { status: "replied", reply, citations: response.citations ?? [] };
  }

  /** Shared resolution: endpoint → current graph snapshot → public definition. 404 on any miss. */
  private async resolve(chatId: string) {
    const endpoint = await this.chats.getEndpoint(chatId);
    if (!endpoint) throw new NotFoundException("Unknown chat");
    // Public trigger fires in the endpoint's OWN environment (design §Slice 4).
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.environmentId,
      endpoint.workflowId,
    );
    if (!snapshot) throw new NotFoundException("Unknown chat");
    const def = extractChatDefinition(snapshot.graph, chatId);
    if (!def) throw new NotFoundException("Unknown chat");
    return { endpoint, snapshot, def };
  }
}

/** Reduce a reply body to text for the history log. Never throws — a non-serializable body
 *  (circular refs, BigInt) falls back to "" so best-effort persistence can't sink the reply. */
function stringifyReply(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (reply == null) return "";
  try {
    return JSON.stringify(reply) ?? "";
  } catch {
    return "";
  }
}
