/**
 * `mqttPublish` activity (#1086 slice 3).
 *
 * Hermetic: `__mqttDeps` swaps connection resolution, the egress guard and the `mqtt` import, so no
 * broker and no credential are needed — the same seam `__kafkaDeps`/`__sqlDeps` provide.
 *
 * What these pin is the part that is OURS: SSRF, credential handling, serialization, and which
 * failures are worth retrying. The protocol's own behaviour is covered by the integration spec
 * against a real broker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import { __mqttDeps, callMqttPublish } from "../src/temporal/activities/mqtt";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "pub" } as never;

let published: Array<{
  topic: string;
  payload: string;
  opts: Record<string, unknown>;
}>;
let connectOptions: Record<string, unknown> | undefined;
let connectUrl: string | undefined;
let ended: number;
let publishImpl: () => Promise<void>;

beforeEach(() => {
  published = [];
  connectOptions = undefined;
  connectUrl = undefined;
  ended = 0;
  publishImpl = async () => {};

  vi.spyOn(__mqttDeps, "resolveMqttConnection").mockResolvedValue({
    url: "mqtts://broker.example.com:8883",
    username: "u",
    password: "p-SENTINEL",
  });
  // Identity by default: the guard's own behaviour is tested in @naary/connections.
  vi.spyOn(__mqttDeps, "resolvePinnedHost").mockImplementation(
    async (h: string) => h,
  );
  vi.spyOn(__mqttDeps, "loadMqtt").mockResolvedValue({
    connectAsync: async (url: string, opts: Record<string, unknown>) => {
      connectUrl = url;
      connectOptions = opts;
      return {
        publishAsync: async (
          topic: string,
          payload: string,
          o: Record<string, unknown>,
        ) => {
          await publishImpl();
          published.push({ topic, payload, opts: o });
        },
        endAsync: async () => {
          ended++;
        },
      };
    },
  } as never);
});

afterEach(() => vi.restoreAllMocks());

const cfg = (over: Record<string, unknown> = {}) =>
  ({
    connectionId: "c1",
    topic: "sensors/1",
    payload: { t: 21 },
    ...over,
  }) as never;

describe("callMqttPublish", () => {
  it("publishes and reports what was SENT — no invented message identity", async () => {
    const res = await callMqttPublish(cfg(), {}, META);
    // MQTT hands a publisher no id: QoS 0 is unacknowledged, QoS 1/2 confirm only the handshake.
    // Returning a fabricated one would invite correlation logic the protocol cannot support.
    expect(res.output).toEqual({ topic: "sensors/1", qos: 1, retained: false });
  });

  it("defaults qos to 1 — never fire-and-forget by omission", async () => {
    await callMqttPublish(cfg(), {}, META);
    // At QoS 0 the broker sends nothing back, so a publish that vanished into a half-open socket
    // completes 'successfully'. Same reasoning as kafkaPublish's acks: -1.
    expect(published[0].opts.qos).toBe(1);
  });

  it("passes a string payload through verbatim, and JSON-encodes anything else", async () => {
    await callMqttPublish(cfg({ payload: '{"already":"json"}' }), {}, META);
    expect(published[0].payload).toBe('{"already":"json"}');

    published = [];
    await callMqttPublish(cfg({ payload: { t: 21 } }), {}, META);
    expect(published[0].payload).toBe('{"t":21}');
  });

  it("sends an EMPTY payload for null — that is how a retained message is cleared", async () => {
    await callMqttPublish(cfg({ payload: null, retain: true }), {}, META);
    expect(published[0].payload).toBe("");
    expect(published[0].opts.retain).toBe(true);
  });

  it("refuses a wildcard topic, which is a subscribe filter and not publishable", async () => {
    for (const topic of ["sensors/+/temp", "sensors/#"]) {
      const err = await callMqttPublish(cfg({ topic }), {}, META).catch(
        (e) => e,
      );
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe("MQTT_CONFIG");
      // Most brokers answer a wildcard publish by closing the connection, with no explanation.
      expect(err.message).toMatch(/wildcard/i);
    }
    expect(connectOptions).toBeUndefined();
  });

  it("SSRF: a private broker address is refused before any socket is opened", async () => {
    vi.spyOn(__mqttDeps, "resolvePinnedHost").mockRejectedValue(
      new BlockedEgressError("10.0.0.5"),
    );
    const err = await callMqttPublish(cfg(), {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("MQTT_EGRESS_BLOCKED");
    expect(connectOptions).toBeUndefined();
  });

  it("connects to the PINNED address, not the DNS name", async () => {
    vi.spyOn(__mqttDeps, "resolvePinnedHost").mockResolvedValue("203.0.113.7");
    await callMqttPublish(cfg(), {}, META);
    // The point of pinning: DNS is resolved once and checked, so it cannot answer differently at
    // connect time (rebinding).
    expect(connectUrl).toContain("203.0.113.7");
    expect(connectUrl).not.toContain("broker.example.com");
  });

  it("NEVER puts the password in the thrown error", async () => {
    publishImpl = async () => {
      throw new Error("Connection refused: Not authorized");
    };
    const err = await callMqttPublish(cfg(), {}, META).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain("p-SENTINEL");
    expect(err.message).not.toContain("p-SENTINEL");
  });

  it("maps an auth refusal to NON-retryable — a rejected credential fails the same way twice", async () => {
    publishImpl = async () => {
      throw new Error("Connection refused: Not authorized");
    };
    const err = await callMqttPublish(cfg(), {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("MQTT_AUTH");
  });

  it("lets a genuinely transient broker error retry", async () => {
    publishImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const err = await callMqttPublish(cfg(), {}, META).catch((e) => e);
    // Not an ApplicationFailure at all — it propagates so Temporal's policy decides.
    expect(err.nonRetryable).toBeUndefined();
  });

  it("ends the client even when the publish throws", async () => {
    publishImpl = async () => {
      throw new Error("ECONNRESET");
    };
    await callMqttPublish(cfg(), {}, META).catch(() => undefined);
    // A leaked connection holds a broker session slot for the life of the worker, and brokers
    // commonly cap connections per credential.
    expect(ended).toBe(1);
  });

  it("never resumes a session: a PUBLISH-only client must not inherit a subscriber's backlog", async () => {
    await callMqttPublish(cfg(), {}, META);
    expect(connectOptions?.clean).toBe(true);
    // And it does not reconnect on its own — that would turn a failed publish into an indefinite
    // hang, and retry policy belongs to Temporal.
    expect(connectOptions?.reconnectPeriod).toBe(0);
  });
});
