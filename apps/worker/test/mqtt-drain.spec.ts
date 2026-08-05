/**
 * The MQTT drain's pure pieces and its ack discipline (#1086 slice 3b), tested hermetically.
 *
 * The two functions here carry claims that are easy to state and easy to get silently wrong:
 *
 * `mqttSessionClientId` IS the resume mechanism. MQTT keeps nothing but the session, and the
 * session is keyed on this string, so "the trigger resumes where it left off" reduces entirely to
 * "this function returns the same 23-or-fewer characters every time, and never the same string for
 * two different triggers". A collision is not a nuisance: a broker answers a duplicate client id by
 * disconnecting the incumbent and handing its queued messages to the newcomer.
 *
 * `mqttRunId` is the OPPOSITE of Kafka's dedupe key and the tests say so, because a reader coming
 * from kafka-drain.spec.ts will otherwise assume parity. Its job is uniqueness — that two distinct
 * messages never collapse into one run — and it deliberately does NOT recognise a redelivery.
 *
 * The consume tests pin the ack discipline through the `__mqttDeps` seam: which messages get a
 * PUBACK, which are deliberately left queued, and the retained-replay drop that stops a retained
 * topic from starting one duplicate run per interval forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __mqttDeps, callMqttConsume } from "../src/temporal/activities/mqtt";
import {
  mqttRunId,
  mqttSessionClientId,
} from "../src/temporal/workflow/mqtt-drain";

const META = { tenantId: "t1", environmentId: "e1" } as never;

const clientId = (
  over: Partial<Parameters<typeof mqttSessionClientId>[0]> = {},
) =>
  mqttSessionClientId({
    tenantId: "t1",
    environmentId: "e1",
    workflowKey: "sensors",
    topic: "sensors/+/temp",
    qos: 1,
    ...over,
  });

describe("mqttSessionClientId — the session, and therefore the resume", () => {
  it("is stable: the same trigger always derives the same session id", () => {
    // If this ever stops holding, every drain starts a NEW session and the previous one's queued
    // messages are abandoned on the broker. The trigger would look like it worked (it connects, it
    // subscribes) and would simply never see anything published between drains.
    expect(clientId()).toBe(clientId());
  });

  it("fits MQTT 3.1.1's guaranteed 23-character client id, without truncating", () => {
    // Brokers are only required to accept 1–23 characters. A longer id works on mosquitto and is
    // rejected by stricter brokers — and the "fix" of truncating is what causes collisions.
    const id = clientId({
      workflowKey: "w".repeat(5_000),
      topic: "#".repeat(500),
    });
    expect(id.length).toBeLessThanOrEqual(23);
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("separates tenants, environments and workflows", () => {
    // Two tenants must never share a session: the second connect would disconnect the first and
    // inherit its queued messages — cross-tenant data exposure, not a collision nuisance.
    expect(clientId({ tenantId: "t1" })).not.toBe(clientId({ tenantId: "t2" }));
    expect(clientId({ environmentId: "e1" })).not.toBe(
      clientId({ environmentId: "e2" }),
    );
    expect(clientId({ workflowKey: "sensors" })).not.toBe(
      clientId({ workflowKey: "alarms" }),
    );
  });

  it("changes when the TOPIC FILTER changes — the subtle one", () => {
    // A session carries its subscriptions, and SUBSCRIBE adds rather than replaces. Keeping the
    // session across a filter edit would leave the OLD filter subscribed forever, so the trigger
    // would keep receiving messages the graph no longer asks for.
    expect(clientId({ topic: "sensors/+/temp" })).not.toBe(
      clientId({ topic: "devices/+/temp" }),
    );
  });

  it("changes when the QoS changes", () => {
    expect(clientId({ qos: 1 })).not.toBe(clientId({ qos: 0 }));
  });
});

const runId = (over: Partial<Parameters<typeof mqttRunId>[0]> = {}) =>
  mqttRunId({
    tenantId: "t1",
    environmentId: "e1",
    workflowKey: "sensors",
    drainRunId: "run-aaa",
    index: 0,
    ...over,
  });

describe("mqttRunId — uniqueness, NOT dedupe", () => {
  it("is stable for a given (drain, index) — which is what makes replay safe", () => {
    // A drain whose workflow task fails midway replays and re-derives these ids; identical ids are
    // how the starts it already made are recognised instead of repeated.
    expect(runId()).toBe(runId());
  });

  it("never gives two messages in one drain the same id", () => {
    expect(runId({ index: 0 })).not.toBe(runId({ index: 1 }));
  });

  it("gives two DIFFERENT drains different ids, even at the same index", () => {
    // The honest inverse of the Kafka test. There, the same message re-drained produces the SAME
    // id and is deduped. Here it produces a different one and starts a second run — because MQTT
    // offers no stable message identity to key on, and a content- or packetId-derived key would
    // collapse two genuinely distinct messages into one run, which is silent data LOSS.
    expect(runId({ drainRunId: "run-aaa" })).not.toBe(
      runId({ drainRunId: "run-bbb" }),
    );
  });

  it("separates tenants, environments and workflows", () => {
    expect(runId({ tenantId: "t1" })).not.toBe(runId({ tenantId: "t2" }));
    expect(runId({ environmentId: "e1" })).not.toBe(
      runId({ environmentId: "e2" }),
    );
    expect(runId({ workflowKey: "a" })).not.toBe(runId({ workflowKey: "b" }));
  });

  it("stays inside Temporal's id limit, keeping the identity tail whole", () => {
    const long = runId({ workflowKey: "w".repeat(5_000), index: 7 });
    expect(long.length).toBeLessThanOrEqual(400);
    // Truncating the HEAD is safe (a constant prefix per graph); truncating the TAIL would merge
    // two different messages into one id — the one failure this function must not have.
    expect(long.endsWith("-run-aaa-7")).toBe(true);
  });

  it("sanitizes characters a Temporal id can't carry, without merging distinct runs", () => {
    const a = runId({ workflowKey: "eu/sensors" });
    const b = runId({ workflowKey: "us/sensors" });
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).not.toBe(b);
  });
});

/* -------------------------------------------------------------------------- */

interface FakeMessage {
  topic?: string;
  payload: string;
  qos?: 0 | 1;
  retain?: boolean;
  dup?: boolean;
}

/**
 * A fake mqtt module that replays a scripted burst through `client.handleMessage`.
 *
 * It reproduces the ONE piece of mqtt.js behaviour the activity is built around: `done()` sends the
 * PUBACK and pumps the parser, `done(err)` skips the PUBACK and still pumps the parser. So the fake
 * records which messages were acknowledged, and a test can assert that a message the drain declined
 * was genuinely left queued rather than quietly consumed.
 */
function fakeMqtt(
  messages: FakeMessage[],
  opts: { sessionPresent?: boolean } = {},
) {
  const record = {
    /** Options the activity connected with — `clean`/`clientId`/`protocolVersion` live here. */
    options: undefined as Record<string, unknown> | undefined,
    subscriptions: [] as Array<{ topic: string; opts: unknown }>,
    acked: [] as string[],
    /** Left UNACKED on purpose — the broker keeps these for the next drain. */
    refused: [] as string[],
    endedForcefully: undefined as boolean | undefined,
  };

  const mod = {
    /** Deliver the backlog, then fail the SUBSCRIBE — the real ordering, since a session's queued
     *  messages arrive after CONNACK and before the SUBACK. */
    failSubscribeAfterDelivery: false,
    /** Emit a socket `error` once the backlog has been delivered, i.e. after connect resolved. */
    emitErrorAfterDelivery: false,
    connect(_url: string, options: Record<string, unknown>) {
      record.options = options;
      const once: Record<string, (arg: unknown) => void> = {};
      const on: Record<string, (arg: unknown) => void> = {};
      const client = {
        handleMessage: (_p: unknown, done: (e?: Error) => void) => done(),
        once(event: string, fn: (arg: unknown) => void) {
          once[event] = fn;
          return client;
        },
        on(event: string, fn: (arg: unknown) => void) {
          on[event] = fn;
          return client;
        },
        connect() {
          // Async, like a real CONNACK, so the activity's handler is installed first.
          setTimeout(
            () =>
              once.connect?.({ sessionPresent: opts.sessionPresent ?? false }),
            0,
          );
          return client;
        },
        async subscribeAsync(topic: string, o: unknown) {
          record.subscriptions.push({ topic, opts: o });
          if (mod.failSubscribeAfterDelivery || mod.emitErrorAfterDelivery) {
            // A session's backlog lands before the SUBACK, so deliver FIRST and only then fail.
            // That is the ordering that makes the bug interesting: messages are already acked.
            await deliver();
            if (mod.failSubscribeAfterDelivery) {
              throw new Error("simulated broker failure during subscribe");
            }
            on.error?.(new Error("simulated socket failure mid-drain"));
            return [];
          }
          // The burst arrives after the SUBACK in the ordinary case.
          void deliver();
          return [];
        },
        async endAsync(force?: boolean) {
          record.endedForcefully = force;
        },
      };

      const deliver = async () => {
        for (const m of messages) {
          const packet = {
            cmd: "publish" as const,
            topic: m.topic ?? "sensors/1/temp",
            payload: Buffer.from(m.payload),
            qos: m.qos ?? 1,
            retain: m.retain ?? false,
            dup: m.dup ?? false,
          };
          await new Promise<void>((resolve) => {
            client.handleMessage(packet, (err?: Error) => {
              if (err) record.refused.push(m.payload);
              else record.acked.push(m.payload);
              resolve();
            });
          });
        }
      };

      return client;
    },
  };
  return { mod, record };
}

describe("callMqttConsume — the session client, and the ack discipline", () => {
  beforeEach(() => {
    vi.spyOn(__mqttDeps, "resolveMqttConnection").mockResolvedValue({
      url: "mqtts://broker.example.com:8883",
      // Present on purpose: the trigger must NOT use the connection's client id (the publish path
      // uses it with `clean: true`, which would destroy this session).
      clientId: "publisher-client",
    });
    vi.spyOn(__mqttDeps, "resolvePinnedHost").mockImplementation(
      async (h: string) => h,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const cfg = (over: Record<string, unknown> = {}) =>
    ({
      connectionId: "c1",
      topic: "sensors/+/temp",
      clientId: "naary-deadbeefcafef00d",
      maxWaitMs: 500,
      ...over,
    }) as never;

  it("connects with clean:false, MQTT 3.1.1, and the DERIVED client id", async () => {
    const { mod, record } = fakeMqtt([]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    await callMqttConsume(cfg(), META);

    // The whole slice in three options. `clean: true` here would tell the broker to discard the
    // session and everything queued in it — which is exactly what the publish client asks for.
    expect(record.options?.clean).toBe(false);
    // Pinned, not inherited: under MQTT 5 `clean: false` with the default session expiry of 0
    // destroys the session at disconnect, so a silent default change would stop all resuming.
    expect(record.options?.protocolVersion).toBe(4);
    expect(record.options?.clientId).toBe("naary-deadbeefcafef00d");
    // NOT the connection's client id — sharing it with the publish path would have every publish
    // wipe this trigger's backlog.
    expect(record.options?.clientId).not.toBe("publisher-client");
  });

  it("subscribes at QoS 1 by default — the broker queues nothing at QoS 0", async () => {
    const { mod, record } = fakeMqtt([]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    await callMqttConsume(cfg(), META);
    expect(record.subscriptions).toEqual([
      { topic: "sensors/+/temp", opts: { qos: 1 } },
    ]);
  });

  it("takes messages, acknowledges them, and parses a JSON body", async () => {
    const { mod, record } = fakeMqtt([
      { payload: '{"tempC":21.5}' },
      { payload: "21.5" },
      { payload: "not,json,at,all" },
    ]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg(), META);

    expect(res.messages[0].payload).toEqual({ tempC: 21.5 });
    expect(res.messages[1].payload).toBe(21.5);
    // A sensor topic carrying CSV or a bare id is not an error — the parse is attempted, never
    // required.
    expect(res.messages[2].payload).toBe("not,json,at,all");
    expect(record.acked).toHaveLength(3);
    expect(record.refused).toEqual([]);
  });

  it("takes at most maxMessages, and LEAVES THE REST QUEUED rather than acking them", async () => {
    const { mod, record } = fakeMqtt([
      { payload: "a" },
      { payload: "b" },
      { payload: "c" },
    ]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg({ maxMessages: 2 }), META);

    expect(res.messages.map((m) => m.payload)).toEqual(["a", "b"]);
    expect(res.stoppedAt).toEqual({ reason: "maxMessages", taken: 2 });
    // THE ASSERTION THAT MATTERS. Acknowledging a message the drain did not take would consume it
    // with no run ever started — a silent loss, and one no other test would notice. Skipping the
    // PUBACK leaves it in the session for the next drain.
    expect(record.acked).toEqual(["a", "b"]);
    expect(record.refused).toEqual(["c"]);
  });

  it("stops on the BYTE budget — maxMessages alone doesn't bound a Temporal payload", async () => {
    const big = "x".repeat(300 * 1024);
    const { mod, record } = fakeMqtt([
      { payload: big },
      { payload: big },
      { payload: big },
    ]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg({ maxMessages: 100 }), META);

    expect(res.stoppedAt?.reason).toBe("maxBytes");
    expect(res.messages.length).toBeLessThan(3);
    // Again: refused, not acked.
    expect(record.refused.length).toBe(3 - res.messages.length);
  });

  it("always takes the first message however large — else the session wedges forever", async () => {
    // A single oversized message must come through. Refusing it would leave it at the head of the
    // session queue to be refused again on every drain, blocking everything behind it.
    const { mod } = fakeMqtt([{ payload: "y".repeat(900 * 1024) }]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg(), META);
    expect(res.messages).toHaveLength(1);
  });

  it("keeps a retained message on a NEW session — it is the topic's current value", async () => {
    const { mod } = fakeMqtt([{ payload: "22.0", retain: true }], {
      sessionPresent: false,
    });
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg(), META);

    expect(res.messages).toHaveLength(1);
    // Surfaced so a graph can refuse to act on a value that may be much older than the run.
    expect(res.messages[0].retain).toBe(true);
    expect(res.droppedRetainedReplays).toBe(0);
    expect(res.sessionPresent).toBe(false);
  });

  it("DROPS a retained replay on an existing session — the once-per-interval duplicate bug", async () => {
    // We re-SUBSCRIBE on every drain so a lost subscription heals itself, and a broker answers
    // every SUBSCRIBE by re-sending matching retained messages. Without this drop, a topic holding
    // a retained value would start one duplicate run every interval, forever. MQTT 3.1.1 §3.3.1.3
    // makes the rule safe: a live publish forwarded to an established subscription MUST have
    // RETAIN cleared, so retain=true here can only be a replay.
    const { mod, record } = fakeMqtt(
      [
        { payload: "22.0", retain: true },
        { payload: "22.5", retain: false },
      ],
      { sessionPresent: true },
    );
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg(), META);

    expect(res.messages.map((m) => m.payload)).toEqual([22.5]);
    expect(res.droppedRetainedReplays).toBe(1);
    // ACKED, not refused: an unacked replay simply comes back, and nobody lost it.
    expect(record.acked).toContain("22.0");
    expect(record.refused).toEqual([]);
  });

  it("reports sessionPresent — the only place a discarded backlog is ever visible", async () => {
    const { mod } = fakeMqtt([], { sessionPresent: true });
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    expect((await callMqttConsume(cfg(), META)).sessionPresent).toBe(true);
  });

  it("ends the client UNFORCED, so the PUBACKs it queued are actually written", async () => {
    // `end(true)` would discard unwritten PUBACKs. The broker would then redeliver those messages
    // — and MQTT having no dedupe key, every one of them becomes a second run.
    const { mod, record } = fakeMqtt([{ payload: "a" }]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    await callMqttConsume(cfg(), META);
    expect(record.endedForcefully).toBe(false);
  });

  it("KEEPS what it acknowledged when the drain fails part-way, and says it failed", async () => {
    // The failure the activity must never turn into loss. A persistent session's backlog starts
    // arriving immediately after CONNACK — before our SUBSCRIBE is even sent — so a `subscribeAsync`
    // that throws has usually already had messages acknowledged behind it. The broker will not send
    // those again, so throwing here would destroy them outright: no run started, no retry able to
    // recover them.
    const { mod, record } = fakeMqtt([{ payload: "a" }, { payload: "b" }]);
    // Deliver the backlog, THEN fail — the real ordering.
    mod.failSubscribeAfterDelivery = true;
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);

    const res = await callMqttConsume(cfg(), META);

    expect(res.messages.map((m) => m.payload)).toEqual(["a", "b"]);
    expect(record.acked).toEqual(["a", "b"]);
    // And NOT reported as a clean read. Without this the batch is indistinguishable from a
    // complete one, which is how a half-drain becomes invisible.
    expect(res.stoppedAt).toEqual({ reason: "error", taken: 2 });
  });

  it("still THROWS when it failed before taking anything — nothing to preserve", async () => {
    // The other half of the rule. With no acknowledged messages there is nothing to salvage, so the
    // drain must fail visibly rather than report a clean empty read that looks like a quiet broker.
    const { mod } = fakeMqtt([]);
    mod.failSubscribeAfterDelivery = true;
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);

    await expect(callMqttConsume(cfg(), META)).rejects.toThrow();
  });

  it("does not swallow a broker error that arrives AFTER the connect succeeded", async () => {
    // The connect promise's `once("error")` is still attached once it has resolved, so without a
    // durable listener a mid-drain socket error would be delivered there and used to reject an
    // already-settled promise — a no-op. The drain would sit out its full wait and report success.
    const { mod, record } = fakeMqtt([{ payload: "a" }]);
    mod.emitErrorAfterDelivery = true;
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);

    const res = await callMqttConsume(cfg({ maxWaitMs: 30_000 }), META);

    expect(res.messages.map((m) => m.payload)).toEqual(["a"]);
    expect(record.acked).toEqual(["a"]);
    expect(res.stoppedAt).toEqual({ reason: "error", taken: 1 });
    // It also ends the drain immediately rather than waiting out `maxWaitMs` on a dead socket —
    // this test would take 30s if the error only stopped the drain by timing out.
  }, 10_000);

  it("returns an empty batch rather than hanging when nothing arrives", async () => {
    const { mod } = fakeMqtt([]);
    vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue(mod as never);
    const res = await callMqttConsume(cfg(), META);
    expect(res.messages).toEqual([]);
    // `null` here means "nothing more arrived in the window" — NOT Kafka's "the topic is empty".
    // MQTT has no queryable backlog to ask about.
    expect(res.stoppedAt).toBeNull();
  });
});
