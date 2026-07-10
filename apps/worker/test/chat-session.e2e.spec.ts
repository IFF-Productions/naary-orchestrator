import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatMessageSignal,
  chatReplyQuery,
  CHAT_SESSION_WORKFLOW,
  TASK_QUEUE,
} from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { chatSession } from "../src/temporal/workflows";

// Temporal's bundler processes this path — must be a real absolute FS path (see interpreter.e2e).
const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

// A minimal chat graph: the chatTrigger's output IS the input; respondToWebhook echoes the message
// back as the reply body. Proves the session runs the child graph and surfaces RunGraphResult.reply.
const echoChatGraph: GraphDef = {
  startNodeId: "chat",
  nodes: [
    { id: "chat", type: "chatTrigger", config: {} as never },
    {
      id: "resp",
      type: "respondToWebhook",
      config: { bodyBinding: { from: "chat", path: "message" } } as never,
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "chat", to: "resp" },
    { from: "resp", to: "end" },
  ],
};

const loadCalls: unknown[] = [];
const appendCalls: {
  sessionId: string;
  userText: string;
  assistantText: string;
}[] = [];

const mockActivities = {
  recordExecution: async (): Promise<void> => undefined,
  setExecutionStatus: async (): Promise<void> => undefined,
  loadChatHistory: async (
    meta: unknown,
  ): Promise<{ role: string; text: string }[]> => {
    loadCalls.push(meta);
    return [];
  },
  appendChatTurn: async (meta: {
    tenantId: string;
    chatId: string;
    sessionId: string;
    userText: string;
    assistantText: string;
  }): Promise<void> => {
    appendCalls.push({
      sessionId: meta.sessionId,
      userText: meta.userText,
      assistantText: meta.assistantText,
    });
  },
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });
}

function startArgs(sessionId: string, idleTimeoutMs?: number) {
  return {
    graph: echoChatGraph,
    ctx: { tenantId: "t-chat", workflowKey: "support" },
    chatId: "c-1",
    sessionId,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  };
}

/** Poll the turn-id-keyed reply query until this turn is answered (bounded). */
async function awaitReply(
  handle: {
    query: (
      q: typeof chatReplyQuery,
      t: string,
    ) => Promise<{ status: string; reply?: unknown }>;
  },
  turnId: string,
): Promise<unknown> {
  for (let i = 0; i < 50; i++) {
    const state = await handle.query(chatReplyQuery, turnId);
    if (state.status === "replied") return state.reply;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`turn ${turnId} never replied`);
}

describe("chatSession — durable per-session chat (design §2.1b, option A)", () => {
  it("signalWithStart runs the graph and returns the reply keyed by turnId", async () => {
    loadCalls.length = 0;
    appendCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.signalWithStart(
        CHAT_SESSION_WORKFLOW,
        {
          workflowId: "chatsession-t-chat-support-s1",
          taskQueue: TASK_QUEUE,
          signal: chatMessageSignal,
          signalArgs: [{ message: "hello", turnId: "turn-1" }],
          args: [startArgs("s1")],
        },
      );
      const reply = await awaitReply(handle, "turn-1");
      expect(reply).toBe("hello"); // respondToWebhook echoed the message

      // A SECOND message reuses the SAME workflow (signalWithStart doesn't restart a running one)
      // and gets its OWN reply under its own turnId — the turn-id keying that fixes the race.
      await handle.signal(chatMessageSignal, {
        message: "world",
        turnId: "turn-2",
      });
      const reply2 = await awaitReply(handle, "turn-2");
      expect(reply2).toBe("world");

      // Persistence is best-effort and runs AFTER the reply is queryable (we don't block the reply
      // on the DB write), so wait for the durable append to land before asserting it.
      for (let i = 0; i < 50 && appendCalls.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // History seeded exactly ONCE (first start), and BOTH turns persisted durably.
      expect(loadCalls).toHaveLength(1);
      expect(appendCalls).toEqual([
        { sessionId: "s1", userText: "hello", assistantText: "hello" },
        { sessionId: "s1", userText: "world", assistantText: "world" },
      ]);

      // An unknown turnId is not "pending" forever — it's reported unknown so the client can stop.
      const missing = await handle.query(chatReplyQuery, "turn-999");
      expect(missing.status).toBe("unknown");

      await handle.cancel().catch(() => undefined); // free the long-lived session
    });
  }, 60_000);

  it("terminates itself after the idle timeout (doesn't hang; reaches the close path)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // Short idle timeout so the close path fires quickly. Process one message, then go silent.
      const handle = await env.client.workflow.signalWithStart(
        CHAT_SESSION_WORKFLOW,
        {
          workflowId: "chatsession-t-chat-support-idle",
          taskQueue: TASK_QUEUE,
          signal: chatMessageSignal,
          signalArgs: [{ message: "bye", turnId: "turn-1" }],
          args: [startArgs("idle", 300)],
        },
      );
      await awaitReply(handle, "turn-1");
      // With no further messages, the idle condition fires → the session drains + returns.
      await handle.result(); // resolves (void) — a hang would time out this test
    });
  }, 60_000);
});
