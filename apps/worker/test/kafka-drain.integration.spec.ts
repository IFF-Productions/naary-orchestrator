import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { Kafka } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KAFKA_DRAIN_WORKFLOW, TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { createLocalTestEnv } from "./local-test-env";
import {
  ensureTopic,
  startTestKafka,
  type TestBroker,
} from "./kafka-container";
import * as activities from "../src/temporal/activities";
import { kafkaDrain, kafkaRunId } from "../src/temporal/workflows";

/**
 * The drain against a REAL broker — and specifically the property #1086 named as slice 2's
 * verification: **a redelivered message starts no second run.**
 *
 * That claim cannot be tested against a fake. It is a statement about Temporal's workflowId reuse
 * policy interacting with a real consumer group's committed offsets, and the failure mode is
 * silent: with the SDK's DEFAULT policy (`ALLOW_DUPLICATE`) the second delivery would start a
 * second run, every assertion about "one run per message" would still pass in a unit test, and the
 * duplicate would only appear in production as a workflow that ran twice.
 *
 * The redelivery is produced honestly: the offsets are rewound with `admin.setOffsets`, which is
 * exactly what a crash between "start the runs" and "commit" leaves behind.
 *
 * Docker-gated (`pnpm test:integration`).
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const TOPIC = "naary.drain.orders";
const GROUP = "naary-drain-it";
const TENANT = "t-drain";
const ENV_ID = "e-drain";
const WORKFLOW_KEY = "orders";

let env: TestWorkflowEnvironment;
let started: TestBroker;
let broker: string;
let kafka: Kafka;

beforeAll(async () => {
  started = await startTestKafka("naary-drain-it");
  broker = started.broker;
  kafka = started.kafka;
  env = await createLocalTestEnv();
  await ensureTopic(kafka, TOPIC);

  activities.__kafkaDeps.resolveKafkaConnection = async () => ({
    brokers: [broker],
    ssl: false,
  });
  activities.__kafkaDeps.resolvePinnedHost = async (host: string) => host;
}, 300_000);

afterAll(async () => {
  await env?.teardown();
  await started?.container.stop();
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

/** The graph each message runs: a kafkaTrigger that publishes the message, then ends. */
const GRAPH: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    {
      id: "trigger",
      type: "kafkaTrigger",
      config: { connectionId: "c", topic: TOPIC, groupId: GROUP },
    },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "trigger", to: "end" }],
};

const drainInput = () => ({
  tenantId: TENANT,
  environmentId: ENV_ID,
  workflowKey: WORKFLOW_KEY,
  graph: GRAPH,
  graphContentHash: "hash-1",
  graphVersion: 1,
  connectionId: "c",
  topic: TOPIC,
  groupId: GROUP,
  maxMessages: 10,
  maxWaitMs: 4_000,
  fromBeginning: true,
});

async function produce(values: string[]): Promise<void> {
  const producer = kafka.producer();
  await producer.connect();
  for (const value of values) {
    await producer.send({ topic: TOPIC, acks: -1, messages: [{ value }] });
  }
  await producer.disconnect();
}

/** Rewind the group to the beginning — exactly what a crash before the commit leaves behind. */
async function rewind(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  await admin.setOffsets({
    groupId: GROUP,
    topic: TOPIC,
    partitions: [{ partition: 0, offset: "0" }],
  });
  await admin.disconnect();
}

describe("kafkaDrain — real broker, real Temporal", () => {
  it("starts one run per message, and a REDELIVERY starts none", async () => {
    await produce(['{"id":1}', '{"id":2}']);
    const worker = await makeWorker();

    await worker.runUntil(async () => {
      // --- first drain: two messages, two runs ---
      const first = await env.client.workflow.execute(kafkaDrain, {
        args: [drainInput()],
        taskQueue: TASK_QUEUE,
        workflowId: "drain-1",
      });
      expect(first.drained).toBe(2);
      expect(first.started).toBe(2);
      expect(first.deduped).toBe(0);

      // The runs are real and addressable by the message's identity — which is the whole
      // mechanism, so it is asserted directly rather than inferred from a count.
      for (const offset of ["0", "1"]) {
        const handle = env.client.workflow.getHandle(
          kafkaRunId({
            tenantId: TENANT,
            environmentId: ENV_ID,
            workflowKey: WORKFLOW_KEY,
            topic: TOPIC,
            partition: 0,
            offset,
          }),
        );
        const desc = await handle.describe();
        expect(desc.status.name).toBeDefined();
      }

      // --- redelivery: rewind the group and drain the SAME messages again ---
      await rewind();
      const second = await env.client.workflow.execute(kafkaDrain, {
        args: [drainInput()],
        taskQueue: TASK_QUEUE,
        workflowId: "drain-2",
      });

      // The messages come off the topic again — the broker has no idea they were handled.
      expect(second.drained).toBe(2);
      // And NOT ONE new run is started. With the SDK's default reuse policy
      // (ALLOW_DUPLICATE) this line reads `started: 2` — the bug this test exists for.
      expect(second.started).toBe(0);
      expect(second.deduped).toBe(2);
    });
  }, 300_000);

  it("an empty topic drains to nothing rather than hanging or failing", async () => {
    // The common case in production, and the one where a wrong wait/stop condition shows up as a
    // schedule that never completes.
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const res = await env.client.workflow.execute(kafkaDrain, {
        args: [{ ...drainInput(), fromBeginning: false, maxWaitMs: 2_000 }],
        taskQueue: TASK_QUEUE,
        workflowId: "drain-empty",
      });
      expect(res).toMatchObject({ drained: 0, started: 0, deduped: 0 });
      // Nothing was dropped — the topic was simply exhausted.
      expect(res.stoppedAt).toBeNull();
    });
  }, 300_000);

  it("registers under the name the schedule starts it by", () => {
    // The API's schedule action names the workflow as a STRING; a rename here would strand every
    // kafkaTrigger schedule with "workflow type not registered" at fire time, which nothing else
    // in the test suite would notice.
    expect(KAFKA_DRAIN_WORKFLOW).toBe("kafkaDrain");
    expect(kafkaDrain.name).toBe("kafkaDrain");
  });
});
