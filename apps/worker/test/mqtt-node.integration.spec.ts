import * as path from "node:path";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { createLocalTestEnv } from "./local-test-env";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

/**
 * `mqttPublish` against a REAL broker (#1086 slice 3).
 *
 * Held to the same standard slice 1 was retro-fitted to: the unit spec swaps `__mqttDeps.loadMqtt`
 * for a fake, which pins OUR logic and by construction cannot catch anything about the wire — a
 * QoS flag the broker rejects, a payload encoding that arrives mangled, a retain flag that does not
 * actually retain. So the node runs through the REAL interpreter, the REAL activity and the REAL
 * mqtt client, and the message is read back by an independent subscriber.
 *
 * Mosquitto is started with the image's own `mosquitto-no-auth.conf`: the default config binds
 * localhost-only and refuses anonymous clients, so a container using it accepts no connection from
 * outside and the failure looks like a network problem rather than a config one.
 *
 * ONE seam is relaxed, as in the SQL/Kafka harnesses: the connection points at the container and
 * `resolvePinnedHost` is identity, because the container is on 127.0.0.1 — which the egress guard
 * rightly blocks in production.
 *
 * Docker-gated (`pnpm test:integration`).
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const TOPIC = "naary/integration/sensors";

let env: TestWorkflowEnvironment;
let container: StartedTestContainer;
let url: string;

beforeAll(async () => {
  container = await new GenericContainer("eclipse-mosquitto:2")
    .withExposedPorts(1883)
    // The image ships this config precisely so a throwaway broker can accept anonymous clients;
    // without it mosquitto 2.x listens on localhost only and denies everything else.
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

/** Subscribe first, then resolve with the first message — an independent observation that shares
 *  no code with the publishing path. */
function awaitMessage(topic: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { reconnectPeriod: 0 });
    let timer: NodeJS.Timeout;
    // ONE teardown, used by every exit — resolve, reject and timeout alike. The first version
    // cleaned up only on the happy path, so a failed connect or subscribe left the timer scheduled
    // (holding the event loop open) and the client connected until it fired. That is how an
    // integration suite turns from "failing" into "hanging", which is much harder to read.
    const done = (err: Error | null, value?: string) => {
      clearTimeout(timer);
      void client.endAsync(true).catch(() => undefined);
      if (err) reject(err);
      else resolve(value as string);
    };
    timer = setTimeout(
      () => done(new Error(`no message on ${topic} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    client.on("error", (e) => done(e as Error));
    client.on("connect", () => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) done(err);
      });
    });
    client.on("message", (_t, payload) => done(null, payload.toString()));
  });
}

function publishFlow(
  payload: unknown,
  over: Record<string, unknown> = {},
): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "pub",
        type: "mqttPublish",
        config: { connectionId: "c", topic: TOPIC, payload, ...over },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "pub" },
      { from: "pub", to: "end" },
    ],
  };
}

describe("mqttPublish — real flow against a real MQTT broker (testcontainers)", () => {
  it("publishes a message a plain subscriber receives, JSON-encoded by the activity", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // Subscribe BEFORE publishing: MQTT has no retention for a live subscriber, so a message
      // published first is simply gone.
      const received = awaitMessage(TOPIC);
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          publishFlow({ deviceId: "d-7", tempC: 21.5 }),
          {},
          { tenantId: "t-mqtt" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-mqtt-publish",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.pub).toEqual({ topic: TOPIC, qos: 1, retained: false });

      // The object was JSON-encoded by the activity, not by the graph.
      expect(JSON.parse(await received)).toEqual({
        deviceId: "d-7",
        tempC: 21.5,
      });
    });
  }, 300_000);

  it("retains when asked — a subscriber that connects LATER still gets it", async () => {
    const worker = await makeWorker();
    const retainedTopic = `${TOPIC}/retained`;
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          publishFlow("still-here", { topic: retainedTopic, retain: true }),
          {},
          { tenantId: "t-mqtt" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-mqtt-retain",
      });
      const result = await handle.result();
      expect((result.ctx.pub as { retained: boolean }).retained).toBe(true);

      // Subscribing AFTER the publish is the whole point of retain — this is the assertion the
      // unit test cannot make, because "retain: true was passed" and "the broker retained it" are
      // different claims.
      expect(await awaitMessage(retainedTopic)).toBe("still-here");
    });
  }, 300_000);
});
