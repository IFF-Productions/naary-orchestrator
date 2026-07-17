// Durable per-session chat workflow (split out of workflows.ts — moved VERBATIM,
// zero behavior change; only the surrounding imports changed). Deterministic
// Temporal workflow code — same Tier-1 rules as run-graph.ts.
import * as wf from "@temporalio/workflow";
import { chatMessageSignal, chatReplyQuery } from "@naary/contracts";
import type { ChatReplyState, ChatTurnInput } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { loadChatHistory, appendChatTurn } from "./proxies";
import { runGraph } from "./run-graph";
import type { RunGraphCtx } from "./types";

// ---------------------------------------------------------------------------
// Durable per-session chat workflow (design §2.1b, option A)
// ---------------------------------------------------------------------------

/** First-start args for a chat session. The graph SNAPSHOT is pinned at session start (later
 *  messages are just Signals), so a mid-session graph edit doesn't take effect until the session
 *  idle-expires — a deliberate choice for a consistent conversation. */
export interface ChatSessionInput {
  graph: GraphDef;
  /** Same non-secret ctx runGraph gets (tenantId + caps + graph hash/version); passed to each
   *  per-message child run. Only tenantId flows through history — no secrets (Tier-1 #4). */
  ctx: RunGraphCtx;
  /** The public chat id + conversation session id — for durable history persistence. */
  chatId: string;
  sessionId: string;
  /** End the session after this much silence. Defaults to CHAT_SESSION_IDLE_TIMEOUT_MS; overridable
   *  so a test can drive the idle-close path without a 30-minute wait. */
  idleTimeoutMs?: number;
}

/** State carried across continueAsNew so a long conversation resumes intact. */
interface ChatSessionResume {
  history: { role: string; text: string }[];
  /** Bounded recent turnId→reply window, carried so a client still polling across a CAN boundary
   *  can still read its reply (advisor: a CAN must not orphan an un-polled reply). */
  recentReplies: { turnId: string; reply: unknown }[];
  /** History already seeded from the durable table — don't reload on a CAN resume. */
  seeded: boolean;
}

/** End the session after this much silence (frees the workflow; the table keeps the history). */
const CHAT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Bound the in-Temporal (and CAN-carried) working history. The table holds the full record. */
const MAX_CHAT_HISTORY_MESSAGES = 40;
/** How many recent replies stay queryable (and cross a CAN). Covers the client's poll window. */
const MAX_CHAT_RECENT_REPLIES = 20;

/** Reduce a reply body to text for history — never throws (a circular/BigInt body → ""). */
function stringifyChatReply(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (reply == null) return "";
  try {
    return JSON.stringify(reply) ?? "";
  } catch {
    return "";
  }
}

/**
 * A long-lived, turn-SERIALIZED conversation. `POST /chat/:id` does `signalWithStart` (starts it on
 * the first message of a session, signals it after) and then Queries `chatReplyQuery(turnId)` for the
 * answer. Replies are keyed by the API-minted `turnId`, so two concurrent messages never read each
 * other's reply — the fix for the cross-talk race that got option A deferred.
 *
 * Each message runs the chat graph as a CHILD `runGraph` (interpreter stays the single source of
 * truth; the reply comes back via RunGraphResult.reply). The ChatMessage table is the durable
 * backing store: seeded once at start, appended each turn — so idle-expiry doesn't lose memory.
 */
export async function chatSession(
  input: ChatSessionInput,
  resume?: ChatSessionResume,
): Promise<void> {
  const { graph, ctx, chatId, sessionId } = input;
  const idleTimeoutMs = input.idleTimeoutMs ?? CHAT_SESSION_IDLE_TIMEOUT_MS;
  const queue: ChatTurnInput[] = [];
  let history = resume?.history ?? [];
  const recentReplies = resume?.recentReplies ?? [];
  let processing: string | undefined;

  wf.setHandler(chatMessageSignal, (turn: ChatTurnInput) => {
    queue.push(turn);
  });
  wf.setHandler(chatReplyQuery, (turnId: string): ChatReplyState => {
    const hit = recentReplies.find((r) => r.turnId === turnId);
    // A recorded turn whose reply is `undefined` ran but produced no synchronous response — terminal
    // `no_reply` (the poll stops + reports "started"); a real reply is `null` at least, never undefined.
    if (hit) {
      return hit.reply === undefined
        ? { status: "no_reply" }
        : { status: "replied", reply: hit.reply };
    }
    const inFlight =
      processing === turnId || queue.some((q) => q.turnId === turnId);
    return { status: inFlight ? "pending" : "unknown" };
  });

  // Seed the working history from the durable table ONCE (first start, not a CAN resume) so a session
  // restarted after idle-expiry resumes with memory.
  if (!resume?.seeded) {
    history = await loadChatHistory({
      tenantId: ctx.tenantId,
      chatId,
      sessionId,
    });
  }

  while (true) {
    const got = await wf.condition(() => queue.length > 0, idleTimeoutMs);
    // Idle → end the session. Re-check the queue for a message delivered in the sliver between the
    // timeout firing and here, and drain in-flight signal handlers, so no message is dropped on close.
    if (!got && queue.length === 0) {
      await wf.condition(() => wf.allHandlersFinished());
      if (queue.length === 0) return;
    }

    const turn = queue.shift();
    if (!turn) continue;
    processing = turn.turnId;

    // Run the chat graph as a child. Deterministic, unique child id per turn (turnId is an API-minted
    // input, not workflow-generated). A per-turn failure must not kill the session — record an error
    // reply and carry on.
    let replyBody: unknown;
    try {
      const child = await wf.executeChild(runGraph, {
        workflowId: `${wf.workflowInfo().workflowId}-turn-${turn.turnId}`,
        args: [
          graph,
          { message: turn.message, sessionId, history },
          { ...ctx },
        ],
      });
      replyBody = child.reply;
    } catch (e) {
      if (e instanceof wf.ContinueAsNew || wf.isCancellation(e)) throw e;
      replyBody = { error: "The chat run failed." };
    }

    // Always record the turn's outcome so chatReplyQuery resolves promptly (a `undefined` reply →
    // `no_reply`, so the API poll returns "started" instead of waiting out the timeout).
    recentReplies.push({ turnId: turn.turnId, reply: replyBody });
    if (recentReplies.length > MAX_CHAT_RECENT_REPLIES) recentReplies.shift();
    processing = undefined;

    // Only a real reply advances memory: a turn with no synchronous response (no respondToWebhook)
    // isn't persisted — matching the non-durable path, which doesn't persist when the graph didn't
    // reply. (A per-turn child failure sets replyBody to an `{error}` object, which IS a reply.)
    if (replyBody !== undefined) {
      const assistantText = stringifyChatReply(replyBody);
      history.push(
        { role: "user", text: turn.message },
        { role: "assistant", text: assistantText },
      );
      if (history.length > MAX_CHAT_HISTORY_MESSAGES) {
        history = history.slice(history.length - MAX_CHAT_HISTORY_MESSAGES);
      }
      // Durable record of the turn (survives idle-expiry / CAN). Best-effort — a store hiccup must not
      // kill a live conversation; the in-Temporal history still serves the current session.
      await appendChatTurn({
        tenantId: ctx.tenantId,
        chatId,
        sessionId,
        userText: turn.message,
        assistantText,
      }).catch(() => undefined);
    }

    // continueAsNew only when the queue is DRAINED (so no un-run message is lost) and history has
    // grown — carrying recentReplies so a client mid-poll still reads its reply.
    if (queue.length === 0 && wf.workflowInfo().continueAsNewSuggested) {
      await wf.continueAsNew<typeof chatSession>(input, {
        history,
        recentReplies,
        seeded: true,
      });
    }
  }
}
