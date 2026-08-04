import * as path from "node:path";
import { KafkaContainer } from "@testcontainers/kafka";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { Kafka, logLevel } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { createLocalTestEnv } from "./local-test-env";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

/**
 * `kafkaPublish` against a REAL broker (#1086 slice 1).
 *
 * Slice 1 shipped with one honest gap, stated in its own PR: *"not verified against a real broker."*
 * Its unit tests swap `__kafkaDeps.loadKafka` for a fake, which pins OUR logic — SSRF, credential
 * handling, serialization, retry classification — and by construction cannot catch anything about
 * the wire: a wrong `acks` shape, a header encoding kafkajs rejects, an offset that comes back a
 * Buffer. This closes that, the same way sql-node.integration.spec closes it for Postgres: the node
 * runs through the REAL interpreter, the REAL activity and the REAL kafkajs client, and the message
 * is read back off the topic by a plain consumer that shares no code with the producer path.
 *
 * ONE seam is relaxed, as in the SQL harness: `resolveKafkaConnection` points at the container, and
 * `resolvePinnedHost` is identity because the container lives on 127.0.0.1 — which the egress guard
 * rightly blocks in production. That guard is unit-tested where it belongs; what is being proven
 * here is the publish PATH.
 *
 * Docker-gated (`pnpm test:integration`).
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const TOPIC = "naary.integration.orders";

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<KafkaContainer["start"]>>;
let broker: string;

beforeAll(async () => {
  container = await new KafkaContainer("confluentinc/cp-kafka:7.6.1").start();
  broker = `${container.getHost()}:${container.getMappedPort(9093)}`;
  env = await createLocalTestEnv();

  // The topic is created up front rather than left to auto-creation: an auto-created topic races
  // the first produce, and a flaky first assertion would be read as a bug in the node.
  const admin = new Kafka({
    clientId: "naary-it-admin",
    brokers: [broker],
    logLevel: logLevel.NOTHING,
  }).admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  activities.__kafkaDeps.resolveKafkaConnection = async () => ({
    brokers: [broker],
    ssl: false,
  });
  activities.__kafkaDeps.resolvePinnedHost = async (host: string) => host;
}, 240_000);

afterAll(async () => {
  await env?.teardown();
  await container?.stop();
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: {
      ...activities,
      recordExecution: async () => undefined,
      setExecutionStatus: async () => undefined,
      loadVariables: async () => ({}),
    },
  });
}

/** Read everything currently on the topic with a throwaway group — no code shared with the
 *  producing path, so this is an independent observation rather than a restatement. */
async function readAll(
  groupId: string,
  expected: number,
): Promise<
  Array<{ value: string; key: string | null; headers: Record<string, string> }>
> {
  const consumer = new Kafka({
    clientId: "naary-it-reader",
    brokers: [broker],
    logLevel: logLevel.NOTHING,
  }).consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  const out: Array<{
    value: string;
    key: string | null;
    headers: Record<string, string>;
  }> = [];
  await new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, 15_000);
    void consumer.run({
      eachMessage: async ({ message }) => {
        out.push({
          value: message.value?.toString() ?? "",
          key: message.key?.toString() ?? null,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
        });
        if (out.length >= expected) {
          clearTimeout(giveUp);
          resolve();
        }
      },
    });
  });
  await consumer.disconnect();
  return out;
}

function publishFlow(): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "pub",
        type: "kafkaPublish",
        config: {
          connectionId: "c",
          topic: TOPIC,
          // An OBJECT, so the activity's JSON encoding is what lands on the wire — the string
          // passthrough is the other branch and is unit-tested.
          value: { id: 91, status: "open" },
          key: "acct-7",
          headers: { source: "naary" },
          correlationId: "corr-1",
          replyTopic: "naary.integration.replies",
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "pub" },
      { from: "pub", to: "end" },
    ],
  };
}

describe("kafkaPublish — real flow against a real Kafka (testcontainers)", () => {
  it("publishes a message a plain consumer can read back, with the identity it reported", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [publishFlow(), {}, { tenantId: "t-kafka-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-kafka-publish",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");

      // The node's OWN report of where the message landed. This is the triple slice 2 will dedupe
      // on, so it has to be real rather than plausible.
      const out = result.ctx.pub as {
        topic: string;
        partition: number;
        offset: string;
      };
      expect(out.topic).toBe(TOPIC);
      expect(out.partition).toBe(0);
      // A STRING offset, from the broker — not a number, and not the placeholder the first version
      // of this activity would have invented.
      expect(typeof out.offset).toBe("string");
      expect(Number(out.offset)).toBeGreaterThanOrEqual(0);

      const [msg] = await readAll("naary-it-verify", 1);
      // The object was JSON-encoded by the activity, not by the graph.
      expect(JSON.parse(msg.value)).toEqual({ id: 91, status: "open" });
      expect(msg.key).toBe("acct-7");
      // The author's header survives, and the correlation pair is really on the wire — the reply
      // machinery (slice 3b) will match on exactly these.
      expect(msg.headers.source).toBe("naary");
      expect(msg.headers.correlationId).toBe("corr-1");
      expect(msg.headers.replyTo).toBe("naary.integration.replies");
    });
  }, 240_000);
});
