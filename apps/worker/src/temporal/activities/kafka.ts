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
 * Publish ONE message to a Kafka topic.
 *
 * SSRF (audit #597): broker hosts are tenant-supplied, exactly like a SQL connection's DSN host,
 * so every broker goes through `resolvePinnedHost` — resolve once, reject private/reserved
 * ranges, and pin the address. Without it a "connection" pointed at 10.0.0.x is a port scanner
 * against our own Postgres and Temporal hosts.
 *
 * AT-LEAST-ONCE, stated rather than implied: a send that times out may still have been written by
 * the broker. Retrying this activity can therefore duplicate a message. That is Kafka's normal
 * contract and the reason slice 2's consumer dedupes on (topic, partition, offset) — but an author
 * publishing to a non-idempotent consumer should know it, which is why `acks` defaults to -1
 * (wait for all in-sync replicas) instead of the faster-but-blind 0.
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

  let conn;
  try {
    conn = await __kafkaDeps.resolveKafkaConnection(
      meta.tenantId,
      cfg.connectionId,
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
          ...(buildHeaders(cfg) ? { headers: buildHeaders(cfg) } : {}),
        },
      ],
    });
    return {
      status: "ok",
      output: {
        topic: record?.topicName ?? cfg.topic,
        partition: record?.partition ?? 0,
        // A string, not a number: Kafka offsets are int64 and exceed Number.MAX_SAFE_INTEGER on a
        // busy topic. Rounding a message's identity would be worse than useless — slice 2 dedupes
        // on it.
        offset: String(record?.baseOffset ?? ""),
      },
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    const message = (e as Error).message ?? "";
    // An auth/authorization refusal is the author's to fix; retrying just re-presents the same
    // rejected credential. Everything else (broker down, leader election, network) is genuinely
    // transient and SHOULD retry.
    if (
      /SASL|Authentication|Authorization|TopicAuthorizationFailed/i.test(
        message,
      )
    ) {
      throw ApplicationFailure.nonRetryable(
        "Kafka refused the connection's credentials, or the topic is not authorized for them.",
        "KAFKA_AUTH",
        { tenantId: meta.tenantId },
      );
    }
    throw e;
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
