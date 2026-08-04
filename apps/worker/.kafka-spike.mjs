/**
 * Spike, not a test. Answers the ONE question slice 2's design rests on:
 *
 *   can offsets be committed from a SEPARATE kafkajs session than the one that consumed?
 *
 * The drain is workflow-orchestrated — consume in activity A, start a run per message in workflow
 * code, commit in activity B — so the commit cannot use `consumer.commitOffsets()` (that needs a
 * live group membership). The cross-session equivalent is `admin.setOffsets`, which requires the
 * group to have NO ACTIVE MEMBERS. Between drains that should hold, because the consume activity
 * disconnects. "Should" is why this exists.
 */
import { KafkaContainer } from "@testcontainers/kafka";
import { Kafka, logLevel } from "kafkajs";

const TOPIC = "spike.orders";
const GROUP = "naary-spike";

const container = await new KafkaContainer("confluentinc/cp-kafka:7.6.1")
  .withExposedPorts(9093)
  .start();
const broker = `${container.getHost()}:${container.getMappedPort(9093)}`;
console.log("broker", broker);

const kafka = new Kafka({ clientId: "spike", brokers: [broker], logLevel: logLevel.NOTHING });

const admin = kafka.admin();
await admin.connect();
await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });

const producer = kafka.producer();
await producer.connect();
for (let i = 0; i < 5; i++) {
  await producer.send({ topic: TOPIC, acks: -1, messages: [{ value: `m${i}` }] });
}
await producer.disconnect();
console.log("produced 5");

/** One bounded drain: consume up to `max`, DO NOT commit, disconnect. */
async function drain(max) {
  const consumer = kafka.consumer({ groupId: GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  const got = [];
  await new Promise(async (resolve) => {
    const done = setTimeout(resolve, 4000);
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ message, partition }) => {
        got.push({ partition, offset: message.offset, value: message.value.toString() });
        if (got.length >= max) {
          clearTimeout(done);
          resolve();
        }
      },
    });
  });
  await consumer.stop();
  await consumer.disconnect();
  return got;
}

const first = await drain(2);
console.log("drain 1:", first);

// The load-bearing call: commit from a DIFFERENT session, group now empty.
const nextOffset = String(Number(first[first.length - 1].offset) + 1);
try {
  await admin.setOffsets({
    groupId: GROUP,
    topic: TOPIC,
    partitions: [{ partition: 0, offset: nextOffset }],
  });
  console.log("setOffsets OK ->", nextOffset);
} catch (e) {
  console.log("setOffsets FAILED:", e.message);
}

const second = await drain(3);
console.log("drain 2:", second);
console.log(
  second[0]?.value === "m2"
    ? "PASS: the second drain resumed AFTER the committed offset"
    : `FAIL: expected m2 first, got ${second[0]?.value}`,
);

// And the negative case the design depends on: does setOffsets refuse while a member is live?
const live = kafka.consumer({ groupId: GROUP });
await live.connect();
await live.subscribe({ topic: TOPIC, fromBeginning: true });
await live.run({ autoCommit: false, eachMessage: async () => {} });
await new Promise((r) => setTimeout(r, 2000));
try {
  await admin.setOffsets({
    groupId: GROUP,
    topic: TOPIC,
    partitions: [{ partition: 0, offset: "0" }],
  });
  console.log("setOffsets while ACTIVE: allowed (so overlap is not fatal)");
} catch (e) {
  console.log("setOffsets while ACTIVE: refused ->", e.message);
}
await live.disconnect();

await admin.disconnect();
await container.stop();
