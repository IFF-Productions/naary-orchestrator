import * as path from "node:path";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MQTT_DRAIN_WORKFLOW, TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { createLocalTestEnv } from "./local-test-env";
import * as activities from "../src/temporal/activities";
import { mqttDrain, mqttRunId } from "../src/temporal/workflows";

/**
 * The MQTT drain against a REAL broker — and above all the claim slice 3b exists to prove:
 * **a message published while nothing is connected is still delivered at the next drain.**
 *
 * That is not testable against a fake, and it is not testable by inspecting our own options either.
 * "We passed `clean: false`" and "the broker held a session, queued the message, and handed it over
 * on reconnect" are different claims, and only the broker can settle the second. Everything about
 * this trigger — the derived client id, the QoS-1 subscription, the pinned MQTT 3.1.1 — exists to
 * make that one sentence true, and every one of them fails SILENTLY: the drain still connects, the
 * subscribe still succeeds, and the messages are simply never there.
 *
 * Mosquitto is started with the image's own `mosquitto-no-auth.conf`, as in mqtt-node.integration:
 * the default config binds localhost-only and refuses anonymous clients, so a container without it
 * accepts nothing from outside and the failure reads as a network problem.
 *
 * ONE seam is relaxed, as in the SQL/Kafka harnesses: the connection points at the container and
 * `resolvePinnedHost` is identity, because the container is on 127.0.0.1 — which the egress guard
 * rightly blocks in production.
 *
 * Docker-gated (`pnpm test:integration`).
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const TOPIC = "naary/drain/sensors";
const TENANT = "t-mqtt-drain";
const ENV_ID = "e-mqtt-drain";

let env: TestWorkflowEnvironment;
let container: StartedTestContainer;
let url: string;

beforeAll(async () => {
  container = await new GenericContainer("eclipse-mosquitto:2")
    .withExposedPorts(1883)
    .withCommand(["mosquitto", "-c", "/mosquitto-no-auth.conf"])
    .start();
  url = `mqtt://${container.getHost()}:${container.getMappedPort(1883)}`;
  env = await createLocalTestEnv();

  activities.__mqttDeps.resolveMqttConnection = async () => ({ url });
  activities.__mqttDeps.resolvePinnedHost = async (host: string) => host;
}, 300_000);

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

/** The graph each message runs: an mqttTrigger that receives the message, then ends. */
function graphFor(topic: string): GraphDef {
  return {
    startNodeId: "trigger",
    nodes: [
      {
        id: "trigger",
        type: "mqttTrigger",
        config: { connectionId: "c", topic },
      },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "trigger", to: "end" }],
  };
}

const drainInput = (over: Record<string, unknown> = {}) => {
  const topic = (over.topic as string) ?? TOPIC;
  return {
    tenantId: TENANT,
    environmentId: ENV_ID,
    workflowKey: "sensors",
    graph: graphFor(topic),
    graphContentHash: "hash-1",
    graphVersion: 1,
    connectionId: "c",
    topic,
    maxMessages: 10,
    maxWaitMs: 3_000,
    ...over,
  };
};

/**
 * Publish with NO subscriber connected — the whole point of the exercise.
 *
 * QoS 1 is not incidental. A broker does not queue QoS-0 messages for an offline session (mosquitto
 * has `queue_qos0_messages`, off by default), so a QoS-0 publish here would vanish and the test
 * would report "persistent sessions don't work" while testing something else entirely.
 *
 * `clean: true` on THIS client is deliberate too: it is a publisher, and it must not create a
 * session of its own that lingers on the broker.
 */
async function publishOffline(
  topic: string,
  payloads: string[],
  opts: { retain?: boolean } = {},
): Promise<void> {
  const client = await mqtt.connectAsync(url, {
    clean: true,
    reconnectPeriod: 0,
  });
  for (const payload of payloads) {
    await client.publishAsync(topic, payload, {
      qos: 1,
      retain: opts.retain ?? false,
    });
  }
  await client.endAsync(false);
}

describe("mqttDrain — real broker, real Temporal", () => {
  it("delivers a message published while NOTHING was connected (the persistent session)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // --- drain 1: creates the session and its QoS-1 subscription. Nothing to collect yet. ---
      const first = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ maxWaitMs: 1_000 })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-drain-1",
      });
      expect(first.drained).toBe(0);
      // The broker had never heard of this client id before.
      expect(first.sessionPresent).toBe(false);

      // --- the gap: publish with no subscriber anywhere. Only a session can save this. ---
      await publishOffline(TOPIC, ['{"tempC":21.5}', '{"tempC":22.0}']);

      // --- drain 2: reconnect and collect what the broker held for us ---
      const second = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput()],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-drain-2",
      });

      // THE ASSERTION THIS SLICE EXISTS FOR. `false` here would mean the broker threw the session
      // away between drains, and `drained: 0` would mean it kept the session but queued nothing —
      // the two distinct ways this design fails, told apart.
      expect(second.sessionPresent).toBe(true);
      expect(second.drained).toBe(2);
      expect(second.started).toBe(2);

      // The runs are real and addressable by the id the drain derived, which is how a message is
      // traced back to its run.
      const desc = await env.client.workflow
        .getHandle(
          mqttRunId({
            tenantId: TENANT,
            environmentId: ENV_ID,
            workflowKey: "sensors",
            drainRunId: (
              await env.client.workflow.getHandle("mqtt-drain-2").describe()
            ).runId,
            index: 0,
          }),
        )
        .describe();
      expect(desc.status.name).toBeDefined();
    });
  }, 300_000);

  it("leaves a message it DECLINED to take queued for the next drain", async () => {
    // The property that replaces Kafka's "commit after the runs start". We cannot defer the ack —
    // mqtt.js sends the PUBACK from the same callback that pumps its parser — but we can decline to
    // ack a message we did not take, and the broker must then keep it. If the refusal path ever
    // acked instead, the surplus message would be consumed with no run started, and NOTHING else in
    // the suite would notice: the first drain looks perfectly healthy.
    const topic = `${TOPIC}/bounded`;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, maxWaitMs: 1_000, workflowKey: "bounded" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-bounded-0",
      });

      await publishOffline(topic, ["first", "second"]);

      const capped = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, maxMessages: 1, workflowKey: "bounded" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-bounded-1",
      });
      expect(capped.drained).toBe(1);
      expect(capped.stoppedAt).toEqual({ reason: "maxMessages", taken: 1 });

      // The one it refused is still there — not acknowledged, not lost.
      const rest = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, workflowKey: "bounded" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-bounded-2",
      });
      expect(rest.drained).toBe(1);
      expect(rest.started).toBe(1);
    });
  }, 300_000);

  it("does not re-run a RETAINED message on every drain", async () => {
    // We re-SUBSCRIBE every drain so a lost subscription heals, and a broker answers every
    // SUBSCRIBE by re-sending matching retained messages. Unguarded, a topic holding a retained
    // value would start one duplicate run per interval, forever — a bug that only ever appears in
    // production, and only for the tenants who use retain.
    const topic = `${TOPIC}/retained`;
    await publishOffline(topic, ["retained-value"], { retain: true });

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const first = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, workflowKey: "retained" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-retained-1",
      });
      // A brand-new session SHOULD see the topic's current value once.
      expect(first.drained).toBe(1);
      expect(first.sessionPresent).toBe(false);

      const second = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, workflowKey: "retained" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-retained-2",
      });
      expect(second.sessionPresent).toBe(true);
      // Replayed by the broker, recognised, dropped — and counted, so the behaviour is visible
      // rather than looking like a message going missing.
      expect(second.drained).toBe(0);
      expect(second.droppedRetainedReplays).toBe(1);
    });
  }, 300_000);

  it("keeps a retained message published while the session was offline, exactly once", async () => {
    // The dangerous edge of the drop rule, and the one place it could destroy a real message. It
    // also turns out to be the case that best justifies the rule existing.
    //
    // The rule assumes a retained PUBLISH arriving on an ESTABLISHED subscription is always a
    // subscribe-time replay. That rests on MQTT 3.1.1 §3.3.1.3: a broker MUST clear RETAIN when
    // forwarding a message that matches an established subscription, and MUST set it only for a
    // message sent because of a NEW subscription. A `retain: true` publish made while our session
    // was offline is queued against that established subscription, so it must arrive with RETAIN=0
    // and be kept. If a broker got that wrong the rule would discard a genuine message and merely
    // increment a counter — silent loss. So it is verified against the broker rather than trusted.
    //
    // What the broker actually does, measured: ONE publish produces TWO deliveries. The queued copy
    // arrives with RETAIN=0 (kept, one run), and our SUBSCRIBE separately replays the retained store
    // with RETAIN=1 (dropped). So the drop rule is not merely tidy here — without it this ordinary
    // scenario, a retained publish landing between two drains, would start TWO runs for one message.
    const topic = `${TOPIC}/retained-offline`;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // Establish the session and its subscription first.
      const first = await env.client.workflow.execute(mqttDrain, {
        args: [
          drainInput({
            topic,
            maxWaitMs: 1_000,
            workflowKey: "retained-offline",
          }),
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-retained-offline-1",
      });
      expect(first.sessionPresent).toBe(false);

      // A RETAINED publish, with our subscriber offline. It goes to the retained store AND is
      // queued for the established subscription.
      await publishOffline(topic, ["live-and-retained"], { retain: true });

      const second = await env.client.workflow.execute(mqttDrain, {
        args: [drainInput({ topic, workflowKey: "retained-offline" })],
        taskQueue: TASK_QUEUE,
        workflowId: "mqtt-retained-offline-2",
      });
      expect(second.sessionPresent).toBe(true);
      // KEPT — delivered with RETAIN cleared, as §3.3.1.3 requires — and run ONCE. A `0` here
      // would be the silent loss this test exists to catch.
      expect(second.drained).toBe(1);
      expect(second.started).toBe(1);
      // And the broker's SEPARATE retained-store replay of the same value was suppressed. Without
      // the drop rule this would be a second run for a single publish.
      expect(second.droppedRetainedReplays).toBe(1);
    });
  }, 300_000);

  it("survives a drain that fails MID-FLIGHT: keeps what it acked, next drain gets the rest", async () => {
    // The recovery story the whole "loss is possible, but narrow" claim rests on, tested against a
    // real broker instead of argued. A drain is made to fail after the session's backlog has already
    // arrived and been acknowledged — the realistic ordering, since a persistent session starts
    // delivering immediately after CONNACK, before our SUBSCRIBE is even sent.
    //
    // Two things must hold, and they pull in opposite directions:
    //   1. The messages it ACKED must still produce runs. The broker will never send them again, so
    //      discarding them on the error would be permanent, unrecoverable loss.
    //   2. The messages it never took must NOT have been acked, so the next drain still gets them.
    //
    // Only the real broker can settle (2): "we skipped the PUBACK" and "the broker kept it for us"
    // are different claims.
    const topic = `${TOPIC}/midfail`;
    const realLoadMqtt = activities.__mqttDeps.loadMqtt;
    const worker = await makeWorker();
    try {
      await worker.runUntil(async () => {
        await env.client.workflow.execute(mqttDrain, {
          args: [
            drainInput({ topic, maxWaitMs: 1_000, workflowKey: "midfail" }),
          ],
          taskQueue: TASK_QUEUE,
          workflowId: "mqtt-midfail-0",
        });

        await publishOffline(topic, ["one", "two", "three"]);

        // Fail the SUBSCRIBE, but only after giving the backlog time to arrive and be acked.
        activities.__mqttDeps.loadMqtt = (async () => ({
          ...mqtt,
          connect: (u: string, o: Record<string, unknown>) => {
            const client = mqtt.connect(u, o);
            const realSubscribe = client.subscribeAsync.bind(client);
            client.subscribeAsync = (async (...args: unknown[]) => {
              const granted = await (
                realSubscribe as (...a: unknown[]) => Promise<unknown>
              )(...args);
              await new Promise((r) => setTimeout(r, 1_200));
              throw new Error("simulated broker failure mid-drain");
            }) as typeof client.subscribeAsync;
            return client;
          },
        })) as typeof activities.__mqttDeps.loadMqtt;

        // maxMessages: 2 of the 3 published, so there is a deliberate remainder to recover.
        const failed = await env.client.workflow.execute(mqttDrain, {
          args: [drainInput({ topic, maxMessages: 2, workflowKey: "midfail" })],
          taskQueue: TASK_QUEUE,
          workflowId: "mqtt-midfail-1",
        });

        // (1) The acknowledged messages survived the failure and got their runs.
        expect(failed.drained).toBe(2);
        expect(failed.started).toBe(2);
        // And the batch is not passed off as a clean read.
        expect(failed.stoppedAt).toEqual({ reason: "error", taken: 2 });

        activities.__mqttDeps.loadMqtt = realLoadMqtt;

        // (2) The message it never took was never acked, so the broker still had it.
        const recovered = await env.client.workflow.execute(mqttDrain, {
          args: [drainInput({ topic, workflowKey: "midfail" })],
          taskQueue: TASK_QUEUE,
          workflowId: "mqtt-midfail-2",
        });
        expect(recovered.drained).toBe(1);
        expect(recovered.started).toBe(1);
        expect(recovered.sessionPresent).toBe(true);
      });
    } finally {
      activities.__mqttDeps.loadMqtt = realLoadMqtt;
    }
  }, 300_000);

  it("registers under the name the schedule starts it by", () => {
    // The API's schedule action names the workflow as a STRING; a rename here would strand every
    // mqttTrigger schedule with "workflow type not registered" at fire time, which nothing else in
    // the suite would catch.
    expect(MQTT_DRAIN_WORKFLOW).toBe("mqttDrain");
    expect(mqttDrain.name).toBe("mqttDrain");
  });
});
