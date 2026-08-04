// Kafka producer activity — `kafkaPublish` (pub/sub design #1086, slice 1).
//
// PUBLISH ONLY, and that is the whole slice. Consuming needs something that holds a connection
// across time, which is a different architecture (slice 2). Producing is an ordinary
// request/response side effect: connect, send, disconnect — so it is an Activity like any other,
// and the workflow stays deterministic (Tier-1 §2/§3).
import { ApplicationFailure } from "@temporalio/activity";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  resolveKafkaConnection,
  resolvePinnedHost,
} from "@naary/connections";
import type { AgentMeta } from "./shared";

/** A resolved kafkaPublish (templates + bindings already applied by the interpreter). NO secrets:
 *  brokers and credentials are resolved from `connectionId` INSIDE this activity. */
export interface KafkaPublishActivityConfig {
  connectionId: string;
  topic: string;
  value: unknown;
  key?: string;
  headers?: Record<string, string>;
  correlationId?: string;
  replyTopic?: string;
  acks?: -1 | 0 | 1;
  timeoutMs?: number;
  costUsd?: number;
}

export interface KafkaPublishResult {
  status: "ok";
  output: { topic: string; partition: number; offset: string };
  costUsd: number;
}

/** Default per-publish timeout. Kafka's own default (30s) is a long time to hold a workflow
 *  activity for a fire-one-message call. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Test seam — mirrors `__sqlDeps`, so a test needs no broker. */
export const __kafkaDeps = {
  resolveKafkaConnection,
  resolvePinnedHost,
  /** Lazily imported: kafkajs pulls in a socket stack we do not want loaded in processes that
   *  never publish, and the workflow BUNDLE must never see it (it is activity-only code). */
  loadKafka: async (): Promise<typeof import("kafkajs")> => import("kafkajs"),
};

/**
 * Serialize a message body for the wire.
 *
 * A string goes out VERBATIM — if an author has already produced JSON, or is publishing CSV or a
 * bare id, re-encoding it would silently double-quote their payload and break every consumer.
 * Anything else is JSON. `undefined`/`null` become a null value, which Kafka treats as a real
 * message (and a compacted topic treats as a tombstone) — so it is preserved rather than
 * defaulted to an empty string.
 */
function serializeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Headers to send: the author's own, plus the correlation pair.
 *
 * The correlation headers are written LAST so they win a collision. If an author sets a literal
 * `correlationId` header AND the config field, the config field is the one the reply machinery
 * (slice 3b) will match on, so it must be the one on the wire — a silent disagreement between
 * them would be undebuggable from the consumer's side.
 */
function buildHeaders(
  cfg: KafkaPublishActivityConfig,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  if (cfg.correlationId) headers.correlationId = cfg.correlationId;
  if (cfg.replyTopic) headers.replyTo = cfg.replyTopic;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** `host:port` → the host, for the egress check. A bare host (no port) is legal in kafkajs. */
function brokerHost(broker: string): string {
  const trimmed = broker.trim();
  const lastColon = trimmed.lastIndexOf(":");
  return lastColon > 0 ? trimmed.slice(0, lastColon) : trimmed;
}

/**
 * Resolve a `kafka` connection into a CONNECTED-READY client: read the row, pin every broker past
 * the egress guard, assemble SASL.
 *
 * Shared by publish and consume DELIBERATELY. These are the two places tenant-supplied broker
 * hosts and stored credentials are handled, and they are exactly the two things that must not
 * drift: a consume path that forgot to pin would be an SSRF hole reachable from a saved workflow,
 * and it would look fine in review because the publish path right above it does it correctly.
 */
async function connectKafka(
  connectionId: string,
  meta: AgentMeta,
): Promise<{
  kafka: InstanceType<
    Awaited<ReturnType<typeof __kafkaDeps.loadKafka>>["Kafka"]
  >;
}> {
  let conn;
  try {
    conn = await __kafkaDeps.resolveKafkaConnection(
      meta.tenantId,
      connectionId,
    );
  } catch (e) {
    // A missing/!kafka/malformed connection is the author's to fix — retrying re-reads the same
    // row and fails identically, so burn no Temporal retries on it.
    throw ApplicationFailure.nonRetryable(
      e instanceof MissingConnectionTokenError
        ? "This Kafka connection has no stored configuration yet."
        : (e as Error).message,
      "KAFKA_CONNECTION",
      { tenantId: meta.tenantId },
    );
  }

  // Pin every broker BEFORE constructing the client, so a blocked host fails before any socket.
  const brokers: string[] = [];
  for (const broker of conn.brokers) {
    const host = brokerHost(broker);
    try {
      const pinned = await __kafkaDeps.resolvePinnedHost(host);
      brokers.push(broker.replace(host, pinned));
    } catch (e) {
      if (e instanceof BlockedEgressError) {
        throw ApplicationFailure.nonRetryable(
          // Names the broker so the author can fix it; carries no credential.
          `Kafka broker '${host}' isn't allowed — brokers must be public hosts (private/reserved addresses are blocked).`,
          "KAFKA_EGRESS_BLOCKED",
        );
      }
      throw e;
    }
  }

  const { Kafka } = await __kafkaDeps.loadKafka();
  // kafkajs types SASLOptions as a DISCRIMINATED union (each mechanism carries its own literal),
  // so a widened `mechanism: "plain" | "scram-…"` does not narrow to any member. Re-assert it per
  // mechanism rather than casting the whole object: a cast here would also silence a genuinely
  // wrong shape, and this is the one place credentials are assembled.
  const sasl = conn.sasl
    ? conn.sasl.mechanism === "plain"
      ? {
          mechanism: "plain" as const,
          username: conn.sasl.username,
          password: conn.sasl.password,
        }
      : conn.sasl.mechanism === "scram-sha-256"
        ? {
            mechanism: "scram-sha-256" as const,
            username: conn.sasl.username,
            password: conn.sasl.password,
          }
        : {
            mechanism: "scram-sha-512" as const,
            username: conn.sasl.username,
            password: conn.sasl.password,
          }
    : undefined;
  const kafka = new Kafka({
    clientId: conn.clientId ?? "naary",
    brokers,
    ssl: conn.ssl ?? false,
    ...(sasl ? { sasl } : {}),
    // kafkajs logs broker errors — which include the host and, on an auth failure, the mechanism.
    // Silence it: our own thrown messages are the supported surface, and Tier-1 §4 keeps
    // credential-adjacent detail out of logs.
    logLevel: 0,
  });
  return { kafka };
}

/**
 * Map a broker error to the right Temporal semantics — shared by every Kafka activity.
 *
 * An auth/authorization refusal is the author's to fix; retrying just re-presents the same
 * rejected credential. Everything else (broker down, leader election, network) is genuinely
 * transient and SHOULD retry, so it propagates untouched.
 *
 * The message NEVER echoes the provider's, because kafkajs error strings can carry the host and
 * the SASL mechanism (Tier-1 §4).
 */
function classifyKafkaError(e: unknown, meta: AgentMeta): unknown {
  const message = (e as Error)?.message ?? "";
  if (
    /SASL|Authentication|Authorization|TopicAuthorizationFailed/i.test(message)
  ) {
    return ApplicationFailure.nonRetryable(
      "Kafka refused the connection's credentials, or the topic is not authorized for them.",
      "KAFKA_AUTH",
      { tenantId: meta.tenantId },
    );
  }
  return e;
}

/**
 * Publish ONE message to a Kafka topic.
 *
 * SSRF (audit #597): broker hosts are tenant-supplied, exactly like a SQL connection's DSN host,
 * so every broker goes through `resolvePinnedHost` — resolve once, reject private/reserved
 * ranges, and pin the address. Without it a "connection" pointed at 10.0.0.x is a port scanner
 * against our own Postgres and Temporal hosts.
 *
 * AT-MOST-ONCE — and the distinction matters, because the first version of this comment said the
 * opposite. THIS NODE never retries (`callKafkaPublish` is `maximumAttempts: 1`), so a failed
 * publish fails the node rather than risking a second copy on the topic. The reason a retry would
 * be unsafe is Kafka's own contract: a send that times out may still have been written, so a
 * second attempt can duplicate. Refusing to retry is how at-most-once is achieved, not a
 * contradiction of it.
 *
 * `acks` defaults to -1 (all in-sync replicas) rather than the faster-but-blind 0, because with no
 * retry the acknowledgement is the ONLY evidence the message landed.
 */
export async function callKafkaPublish(
  cfg: KafkaPublishActivityConfig,
  _input: unknown,
  meta: AgentMeta,
): Promise<KafkaPublishResult> {
  if (!cfg.topic?.trim()) {
    throw ApplicationFailure.nonRetryable(
      "kafkaPublish needs a topic.",
      "KAFKA_CONFIG",
    );
  }

  const { kafka } = await connectKafka(cfg.connectionId, meta);

  const headers = buildHeaders(cfg);
  const producer = kafka.producer();
  try {
    await producer.connect();
    const [record] = await producer.send({
      topic: cfg.topic,
      acks: cfg.acks ?? -1,
      timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      messages: [
        {
          value: serializeValue(cfg.value),
          ...(cfg.key ? { key: cfg.key } : {}),
          ...(headers ? { headers } : {}),
        },
      ],
    });
    // NO PLACEHOLDER IDENTITY. `partition: 0, offset: ""` would be a lie that downstream logic
    // cannot detect: (topic, partition, offset) IS a message's identity — it is what slice 2
    // dedupes on — so a fabricated one silently corrupts correlation. If the broker did not tell
    // us where the message landed, say so instead of guessing.
    if (
      !record ||
      record.partition === undefined ||
      record.baseOffset === undefined ||
      record.baseOffset === null
    ) {
      throw ApplicationFailure.nonRetryable(
        "Kafka accepted the publish but returned no partition/offset metadata, so the message " +
          "cannot be identified. This usually means acks=0 — set acks to 1 or -1 to get it.",
        "KAFKA_NO_METADATA",
      );
    }
    return {
      status: "ok",
      output: {
        topic: record.topicName ?? cfg.topic,
        partition: record.partition,
        // A string, not a number: Kafka offsets are int64 and exceed Number.MAX_SAFE_INTEGER on a
        // busy topic. Rounding a message's identity would be worse than useless.
        offset: String(record.baseOffset),
      },
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    throw classifyKafkaError(e, meta);
  } finally {
    // Always disconnect: a leaked producer holds broker sockets open for the life of the worker,
    // and this activity is per-message.
    try {
      await producer.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Consume side — the scheduled drain (#1086 slice 2)                          */
/* -------------------------------------------------------------------------- */

/** A resolved kafkaTrigger drain. No secrets: brokers/credentials come from `connectionId`. */
export interface KafkaConsumeActivityConfig {
  connectionId: string;
  topic: string;
  groupId: string;
  maxMessages?: number;
  maxWaitMs?: number;
  fromBeginning?: boolean;
}

/** One drained message. `offset` is a string for the same reason the publish result's is. */
export interface KafkaDrainedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  /** Parsed when the body was JSON, the raw string otherwise — a CSV or bare-id topic is legal. */
  value: unknown;
  headers: Record<string, string>;
  /** Broker timestamp, ISO-8601. */
  timestamp: string;
}

export interface KafkaConsumeResult {
  messages: KafkaDrainedMessage[];
  /**
   * How many messages this drain declined to take because a bound was hit, and which bound.
   *
   * Reported rather than swallowed: a drain that silently stops at its cap looks exactly like a
   * drain that emptied the topic, and the difference is whether a backlog is growing. `null` when
   * the drain ended because there was nothing left.
   */
  stoppedAt: { reason: "maxMessages" | "maxBytes"; taken: number } | null;
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_WAIT_MS = 5_000;
/**
 * Byte ceiling for ONE drain's returned batch.
 *
 * Temporal's payload cap (~2MB) applies to this activity's RESULT, not to a single message — so
 * `maxMessages` alone bounds nothing useful: 50 × 100KB blows through it, and the failure would be
 * a Temporal error naming a size, not a Kafka topic. Held well under the cap because the messages
 * are re-serialized into the workflow's own history too.
 */
const MAX_BATCH_BYTES = 512 * 1024;

/** Body → value. JSON when it parses, the raw string otherwise. A topic carrying CSV or a bare id
 *  is not an error, so the parse is ATTEMPTED, never required. */
function parseMessageValue(raw: Buffer | null): unknown {
  if (raw === null) return null; // a tombstone is a real message with a null body
  const text = raw.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Drain up to `maxMessages` from a topic, WITHOUT committing.
 *
 * The commit is deliberately not here: the drain workflow starts one run per message and only then
 * commits, so a crash between the two redelivers rather than loses. That ordering is what makes the
 * pipeline at-least-once, and the workflowId dedupe is what makes at-least-once harmless.
 *
 * Messages are taken as a CONTIGUOUS PREFIX per partition — once any bound is hit the drain stops
 * accepting entirely, rather than skipping a large message and taking the next one. That matters
 * because the committed offset is `max + 1`: taking 0,1,2,4 and committing 5 would step over
 * message 3 forever.
 */
export async function callKafkaConsume(
  cfg: KafkaConsumeActivityConfig,
  meta: AgentMeta,
): Promise<KafkaConsumeResult> {
  const { kafka } = await connectKafka(cfg.connectionId, meta);
  const maxMessages = Math.max(
    1,
    Math.floor(cfg.maxMessages ?? DEFAULT_MAX_MESSAGES),
  );
  const maxWaitMs = Math.max(
    500,
    Math.floor(cfg.maxWaitMs ?? DEFAULT_MAX_WAIT_MS),
  );

  const consumer = kafka.consumer({ groupId: cfg.groupId });
  const messages: KafkaDrainedMessage[] = [];
  let stoppedAt: KafkaConsumeResult["stoppedAt"] = null;
  let bytes = 0;
  let accepting = true;

  try {
    await consumer.connect();
    await consumer.subscribe({
      topic: cfg.topic,
      fromBeginning: cfg.fromBeginning ?? false,
    });

    await new Promise<void>((resolve) => {
      // The drain ends on EITHER condition — a full batch or the wait elapsing. An empty topic is
      // the common case and must cost exactly `maxWaitMs`, not hang the activity.
      const timer = setTimeout(resolve, maxWaitMs);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      void consumer.run({
        // Never let kafkajs commit for us: the whole design turns on committing AFTER the runs
        // have been started.
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          if (!accepting) return;
          const size = message.value?.length ?? 0;
          if (messages.length > 0 && bytes + size > MAX_BATCH_BYTES) {
            accepting = false;
            stoppedAt = { reason: "maxBytes", taken: messages.length };
            finish();
            return;
          }
          bytes += size;
          messages.push({
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value: parseMessageValue(message.value),
            headers: Object.fromEntries(
              Object.entries(message.headers ?? {}).map(([k, v]) => [
                k,
                v === undefined || v === null ? "" : String(v),
              ]),
            ),
            timestamp: new Date(Number(message.timestamp)).toISOString(),
          });
          if (messages.length >= maxMessages) {
            accepting = false;
            stoppedAt = { reason: "maxMessages", taken: messages.length };
            finish();
          }
        },
      });
    });
  } catch (e) {
    throw classifyKafkaError(e, meta);
  } finally {
    // stop() before disconnect(): it lets the in-flight `eachMessage` settle, so the group leaves
    // cleanly and the NEXT drain's `admin.setOffsets` finds no active member (which the broker
    // refuses — verified against a real broker, not assumed).
    try {
      await consumer.stop();
    } catch {
      /* best-effort */
    }
    try {
      await consumer.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
  return { messages, stoppedAt };
}

/** Where a partition should resume. `offset` is the NEXT offset to read (max seen + 1). */
export interface KafkaCommitConfig {
  connectionId: string;
  topic: string;
  groupId: string;
  offsets: Array<{ partition: number; offset: string }>;
}

/**
 * Commit the drain's offsets, from a DIFFERENT session than the one that consumed.
 *
 * `consumer.commitOffsets()` cannot be used here: it needs a live group membership, and the
 * consuming activity has already disconnected by the time the runs are started. `admin.setOffsets`
 * is the cross-session equivalent — and it requires the group to have NO ACTIVE MEMBERS, which is
 * exactly why the schedule must use `overlap: SKIP`. Both halves of that were verified against a
 * real broker before this was built: the commit works between drains, and the broker refuses it
 * ("The consumer group must have no running instances") while a member is live.
 *
 * RETRYABLE on purpose. If this fails permanently the runs have already been started, so the next
 * drain redelivers those messages — and the workflowId dedupe turns the second delivery into a
 * no-op. Losing the commit costs a repeated drain, never a lost or duplicated run.
 */
export async function callKafkaCommit(
  cfg: KafkaCommitConfig,
  meta: AgentMeta,
): Promise<void> {
  if (cfg.offsets.length === 0) return; // an empty drain has nothing to move
  const { kafka } = await connectKafka(cfg.connectionId, meta);
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.setOffsets({
      groupId: cfg.groupId,
      topic: cfg.topic,
      partitions: cfg.offsets.map((o) => ({
        partition: o.partition,
        offset: o.offset,
      })),
    });
  } catch (e) {
    throw classifyKafkaError(e, meta);
  } finally {
    try {
      await admin.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
}
