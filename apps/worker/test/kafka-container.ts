/**
 * Shared Kafka testcontainer setup for the integration specs.
 *
 * It exists for one reason: `admin.createTopics` immediately after the container reports "started"
 * fails intermittently with `KafkaJSBrokerNotFound: Broker -1 not found in the cached metadata`.
 * Broker −1 is "no controller elected yet" — the container's port is open and accepting
 * connections before KRaft has finished electing one, so the readiness signal is true and the
 * cluster still isn't usable.
 *
 * The publish spec happened to win that race and the drain spec happened to lose it, which is the
 * worst possible split: one green suite, one red, same code. So the wait is explicit and shared,
 * rather than left to whichever spec gets unlucky in CI.
 */
import { KafkaContainer } from "@testcontainers/kafka";
import { Kafka, logLevel } from "kafkajs";

export interface TestBroker {
  container: Awaited<ReturnType<KafkaContainer["start"]>>;
  /** `host:port` for the mapped listener. */
  broker: string;
  kafka: Kafka;
}

/** Start a throwaway broker and wait until it can actually serve admin requests. */
export async function startTestKafka(
  clientId = "naary-it",
): Promise<TestBroker> {
  const container = await new KafkaContainer(
    "confluentinc/cp-kafka:7.6.1",
  ).start();
  const broker = `${container.getHost()}:${container.getMappedPort(9093)}`;
  const kafka = new Kafka({
    clientId,
    brokers: [broker],
    logLevel: logLevel.NOTHING,
  });
  await waitForController(kafka);
  return { container, broker, kafka };
}

/** Poll until the cluster has a controller — i.e. until `admin` calls will succeed. */
async function waitForController(
  kafka: Kafka,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const admin = kafka.admin();
    try {
      await admin.connect();
      // listTopics goes through the same metadata/controller path createTopics needs, so a
      // success here means the next admin call will not hit "Broker -1".
      await admin.listTopics();
      await admin.disconnect();
      return;
    } catch (e) {
      lastError = e;
      await admin.disconnect().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Kafka container never elected a controller within ${timeoutMs}ms: ${(lastError as Error)?.message}`,
  );
}

/** Create a topic, tolerating "already exists" so a spec can call it freely. */
export async function ensureTopic(
  kafka: Kafka,
  topic: string,
  numPartitions = 1,
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic, numPartitions }] });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}
