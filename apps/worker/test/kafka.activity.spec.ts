/**
 * `kafkaPublish` activity (#1086 slice 1).
 *
 * Hermetic: `__kafkaDeps` swaps connection resolution, the egress guard and the kafkajs import,
 * so no broker and no credential are needed — the same seam `__sqlDeps` provides.
 *
 * What these pin is the part that is ours: SSRF, credential handling, serialization, and which
 * failures are worth retrying. kafkajs's own wire behaviour is its problem, not ours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import {
  __kafkaDeps,
  callKafkaPublish,
} from "../src/temporal/activities/kafka";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "pub" } as never;

/** Records what reached the producer, so a test asserts the MESSAGE, not just that send ran. */
let sent: Array<Record<string, unknown>>;
let producerConnected: number;
let producerDisconnected: number;
let kafkaOptions: Record<string, unknown> | undefined;
let sendImpl: (args: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
  sent = [];
  producerConnected = 0;
  producerDisconnected = 0;
  kafkaOptions = undefined;
  sendImpl = async (args) => {
    sent.push(args);
    return [{ topicName: args.topic, partition: 3, baseOffset: "42" }];
  };

  vi.spyOn(__kafkaDeps, "resolveKafkaConnection").mockResolvedValue({
    brokers: ["broker.example.com:9092"],
    ssl: true,
    sasl: {
      mechanism: "scram-sha-512",
      username: "u",
      password: "p-SENTINEL",
    },
  });
  // Identity by default: the guard's own behaviour is tested in @naary/connections.
  vi.spyOn(__kafkaDeps, "resolvePinnedHost").mockImplementation(
    async (h: string) => h,
  );
  vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue({
    Kafka: class {
      constructor(opts: Record<string, unknown>) {
        kafkaOptions = opts;
      }
      producer() {
        return {
          connect: async () => {
            producerConnected++;
          },
          send: sendImpl,
          disconnect: async () => {
            producerDisconnected++;
          },
        };
      }
    },
  } as never);
});

afterEach(() => vi.restoreAllMocks());

const cfg = (over: Record<string, unknown> = {}) =>
  ({ connectionId: "c1", topic: "orders", value: { id: 1 }, ...over }) as never;

describe("callKafkaPublish", () => {
  it("publishes and returns the message's identity", async () => {
    const res = await callKafkaPublish(cfg(), {}, META);
    // offset is a STRING: Kafka offsets are int64 and exceed Number.MAX_SAFE_INTEGER on a busy
    // topic. Rounding the identity slice 2 dedupes on would be worse than useless.
    expect(res.output).toEqual({ topic: "orders", partition: 3, offset: "42" });
    expect(typeof res.output.offset).toBe("string");
  });

  it("defaults acks to -1 — never fire-and-forget by omission", async () => {
    await callKafkaPublish(cfg(), {}, META);
    // 0 is expressible but must never be IMPLIED: a publish nobody acknowledges cannot be
    // distinguished from one that failed.
    expect(sent[0].acks).toBe(-1);
  });

  it("passes a string body through verbatim, and JSON-encodes anything else", async () => {
    await callKafkaPublish(cfg({ value: '{"already":"json"}' }), {}, META);
    expect((sent[0].messages as never[])[0]).toMatchObject({
      value: '{"already":"json"}',
    });

    sent = [];
    await callKafkaPublish(cfg({ value: { id: 7 } }), {}, META);
    expect((sent[0].messages as never[])[0]).toMatchObject({
      value: '{"id":7}',
    });
  });

  it("keeps a null value as null — a tombstone is a real message, not an empty string", async () => {
    await callKafkaPublish(cfg({ value: null }), {}, META);
    expect((sent[0].messages as never[])[0]).toMatchObject({ value: null });
  });

  it("writes correlation headers, and they beat a same-named author header", async () => {
    await callKafkaPublish(
      cfg({
        headers: { source: "naary", correlationId: "STALE" },
        correlationId: "corr-9",
        replyTopic: "orders.reply",
      }),
      {},
      META,
    );
    const headers = (sent[0].messages as never[])[0]["headers"];
    // The config field is what the reply machinery will match on, so it must be what is on the
    // wire — a silent disagreement between the two would be undebuggable from the consumer side.
    expect(headers).toEqual({
      source: "naary",
      correlationId: "corr-9",
      replyTo: "orders.reply",
    });
  });

  it("SSRF: a private broker address is refused before any socket is opened", async () => {
    vi.spyOn(__kafkaDeps, "resolvePinnedHost").mockRejectedValue(
      new BlockedEgressError("10.0.0.5"),
    );
    const err = await callKafkaPublish(cfg(), {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("KAFKA_EGRESS_BLOCKED");
    // "before any socket" is the actual property — the client must never have been built.
    expect(producerConnected).toBe(0);
    expect(kafkaOptions).toBeUndefined();
  });

  it("NEVER puts the SASL password in the thrown error", async () => {
    sendImpl = async () => {
      throw new Error("SASL Authentication failed");
    };
    const err = await callKafkaPublish(cfg(), {}, META).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain("p-SENTINEL");
    expect(err.message).not.toContain("p-SENTINEL");
  });

  it("maps an auth refusal to NON-retryable — a rejected credential fails the same way twice", async () => {
    sendImpl = async () => {
      throw new Error("SASL Authentication failed");
    };
    const err = await callKafkaPublish(cfg(), {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("KAFKA_AUTH");
  });

  it("lets a genuinely transient broker error retry", async () => {
    sendImpl = async () => {
      throw new Error("Broker not available: leader election in progress");
    };
    const err = await callKafkaPublish(cfg(), {}, META).catch((e) => e);
    // Not an ApplicationFailure at all — it propagates as-is so Temporal's retry policy decides.
    expect(err.nonRetryable).toBeUndefined();
  });

  it("disconnects the producer even when the send throws", async () => {
    sendImpl = async () => {
      throw new Error("Broker not available");
    };
    await callKafkaPublish(cfg(), {}, META).catch(() => undefined);
    // A leaked producer holds broker sockets for the life of the worker, and this activity runs
    // once per message.
    expect(producerDisconnected).toBe(1);
  });

  it("a missing topic is a config error, not a broker round trip", async () => {
    const err = await callKafkaPublish(cfg({ topic: "  " }), {}, META).catch(
      (e) => e,
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("KAFKA_CONFIG");
    expect(kafkaOptions).toBeUndefined();
  });

  it("silences kafkajs's own logger — it prints hosts and auth mechanisms", async () => {
    await callKafkaPublish(cfg(), {}, META);
    expect(kafkaOptions?.logLevel).toBe(0);
  });
});
