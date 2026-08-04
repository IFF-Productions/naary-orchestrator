/**
 * The Kafka drain's two load-bearing pieces (#1086 slice 2), tested where they are pure.
 *
 * `kafkaRunId` IS the dedupe. Every claim about redelivery being a no-op reduces to "the same
 * message produces the same workflowId, and two different messages never do" — so that is what is
 * asserted here, rather than in an integration test where a collision would show up as a mystery.
 *
 * The consume BOUNDS are the other half: the batch is what crosses Temporal's payload cap, and a
 * drain that silently stops at a limit is indistinguishable from one that emptied the topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __kafkaDeps,
  callKafkaConsume,
} from "../src/temporal/activities/kafka";
import { kafkaRunId } from "../src/temporal/workflow/kafka-drain";

const META = { tenantId: "t1", environmentId: "e1" } as never;

const id = (over: Partial<Parameters<typeof kafkaRunId>[0]> = {}) =>
  kafkaRunId({
    tenantId: "t1",
    environmentId: "e1",
    workflowKey: "orders",
    topic: "acme.orders",
    partition: 0,
    offset: "41",
    ...over,
  });

describe("kafkaRunId — the dedupe key", () => {
  it("is stable: the same message always produces the same id", () => {
    expect(id()).toBe(id());
  });

  it("separates tenants — a topic name is TENANT-SUPPLIED and workflowIds are namespace-global", () => {
    // Without the tenant in the id, two tenants consuming a topic they both named `orders` would
    // share dedupe keys: one tenant's redelivery would silently suppress the other's FIRST
    // delivery. That is a cross-tenant data-loss bug, not a collision nuisance.
    expect(id({ tenantId: "t1" })).not.toBe(id({ tenantId: "t2" }));
  });

  it("separates environments and workflows", () => {
    expect(id({ environmentId: "e1" })).not.toBe(id({ environmentId: "e2" }));
    expect(id({ workflowKey: "orders" })).not.toBe(
      id({ workflowKey: "refunds" }),
    );
  });

  it("separates partition and offset — the message's own identity", () => {
    expect(id({ partition: 0 })).not.toBe(id({ partition: 1 }));
    expect(id({ offset: "41" })).not.toBe(id({ offset: "42" }));
  });

  it("sanitizes characters Temporal ids can't carry, without merging distinct messages", () => {
    const a = id({ topic: "acme/orders#eu" });
    const b = id({ topic: "acme/orders#us" });
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    // Sanitizing must not be a hash collision: two topics that differ stay different.
    expect(a).not.toBe(b);
  });

  it("stays inside Temporal's id limit even with absurd inputs, keeping the identity whole", () => {
    const long = id({ workflowKey: "w".repeat(5_000), offset: "987654321" });
    expect(long.length).toBeLessThanOrEqual(400);
    // The TAIL carries the identity, so truncation must never eat it — otherwise two different
    // messages could end up with the same id, which is the one failure this function must not have.
    expect(long.endsWith("-0-987654321")).toBe(true);
  });
});

/** A fake kafkajs whose consumer replays a scripted batch through `eachMessage`. */
function fakeKafka(
  messages: Array<{ offset: string; value: string; partition?: number }>,
) {
  return {
    Kafka: class {
      consumer() {
        return {
          connect: async () => {},
          subscribe: async () => {},
          run: async ({
            eachMessage,
          }: {
            eachMessage: (a: unknown) => Promise<void>;
          }) => {
            for (const m of messages) {
              await eachMessage({
                topic: "orders",
                partition: m.partition ?? 0,
                message: {
                  offset: m.offset,
                  key: null,
                  value: Buffer.from(m.value),
                  headers: {},
                  timestamp: "1770000000000",
                },
              });
            }
          },
          stop: async () => {},
          disconnect: async () => {},
        };
      }
      producer() {
        return {};
      }
      admin() {
        return {};
      }
    },
  } as never;
}

describe("callKafkaConsume — bounds", () => {
  beforeEach(() => {
    vi.spyOn(__kafkaDeps, "resolveKafkaConnection").mockResolvedValue({
      brokers: ["broker.example.com:9092"],
      ssl: true,
    });
    vi.spyOn(__kafkaDeps, "resolvePinnedHost").mockImplementation(
      async (h: string) => h,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const cfg = (over: Record<string, unknown> = {}) =>
    ({
      connectionId: "c1",
      topic: "orders",
      groupId: "g1",
      maxWaitMs: 500,
      ...over,
    }) as never;

  it("takes at most maxMessages, and SAYS it stopped early", async () => {
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([
        { offset: "0", value: "a" },
        { offset: "1", value: "b" },
        { offset: "2", value: "c" },
      ]),
    );
    const res = await callKafkaConsume(cfg({ maxMessages: 2 }), META);
    expect(res.messages.map((m) => m.offset)).toEqual(["0", "1"]);
    // A drain that quietly stops at its cap looks exactly like a drain that emptied the topic —
    // and the difference is whether a backlog is growing.
    expect(res.stoppedAt).toEqual({ reason: "maxMessages", taken: 2 });
  });

  it("reports nothing when the topic simply ran dry", async () => {
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([{ offset: "0", value: "a" }]),
    );
    const res = await callKafkaConsume(cfg({ maxMessages: 10 }), META);
    expect(res.messages).toHaveLength(1);
    expect(res.stoppedAt).toBeNull();
  });

  it("stops on the BYTE budget — maxMessages alone doesn't bound a Temporal payload", async () => {
    // 50 × 100KB passes any sane message count and still blows the ~2MB history limit. The
    // failure would surface as a Temporal size error naming no topic.
    const big = "x".repeat(300 * 1024);
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([
        { offset: "0", value: big },
        { offset: "1", value: big },
        { offset: "2", value: big },
      ]),
    );
    const res = await callKafkaConsume(cfg({ maxMessages: 100 }), META);
    expect(res.stoppedAt?.reason).toBe("maxBytes");
    expect(res.messages.length).toBeLessThan(3);
  });

  it("always takes the first message, however large — else the topic wedges forever", async () => {
    // A single message over the budget must still come through: skipping it would leave it
    // uncommitted and re-read on every drain, blocking the partition permanently.
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([{ offset: "0", value: "y".repeat(900 * 1024) }]),
    );
    const res = await callKafkaConsume(cfg(), META);
    expect(res.messages).toHaveLength(1);
  });

  it("takes a CONTIGUOUS prefix — never skipping one message and taking the next", async () => {
    // The commit is `max + 1`, so taking 0,1,3 and committing 4 would step over message 2 and
    // lose it silently. Once a bound is hit the drain stops accepting entirely.
    const big = "z".repeat(400 * 1024);
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([
        { offset: "0", value: "small" },
        { offset: "1", value: big },
        { offset: "2", value: "small" },
      ]),
    );
    const res = await callKafkaConsume(cfg({ maxMessages: 100 }), META);
    const offsets = res.messages.map((m) => Number(m.offset));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBe(offsets[i - 1] + 1);
    }
  });

  it("parses a JSON body, and leaves a non-JSON one as text", async () => {
    vi.spyOn(__kafkaDeps, "loadKafka").mockResolvedValue(
      fakeKafka([
        { offset: "0", value: '{"id":7}' },
        { offset: "1", value: "not,json,at,all" },
      ]),
    );
    const res = await callKafkaConsume(cfg(), META);
    expect(res.messages[0].value).toEqual({ id: 7 });
    // A topic carrying CSV or a bare id is not an error — the parse is attempted, never required.
    expect(res.messages[1].value).toBe("not,json,at,all");
  });
});
