// MQTT producer activity — `mqttPublish` (pub/sub design #1086, slice 3).
//
// PUBLISH ONLY. Subscribing needs a persistent session (`clean: false` + a stable client id) so
// QoS-1 messages survive the gaps between drains — a genuinely different lifecycle from Kafka's
// offset-based resume, which is why #1086 made it its own slice rather than a config flag.
//
// Producing is an ordinary request/response side effect: connect, publish, end. So it is an
// Activity like any other and the workflow stays deterministic (Tier-1 §2/§3).
import { ApplicationFailure } from "@temporalio/activity";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  resolveMqttConnection,
  resolvePinnedHost,
} from "@naary/connections";
import type { AgentMeta } from "./shared";

/** A resolved mqttPublish (templates already applied). NO secrets: the broker URL and credentials
 *  are resolved from `connectionId` INSIDE this activity. */
export interface MqttPublishActivityConfig {
  connectionId: string;
  topic: string;
  payload: unknown;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  timeoutMs?: number;
  costUsd?: number;
}

export interface MqttPublishResult {
  status: "ok";
  output: { topic: string; qos: number; retained: boolean };
  costUsd: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Test seam — mirrors `__kafkaDeps`, so a test needs no broker. */
export const __mqttDeps = {
  resolveMqttConnection,
  resolvePinnedHost,
  /** Lazily imported: `mqtt` pulls in a socket/websocket stack we do not want loaded in processes
   *  that never publish, and the workflow BUNDLE must never see it (activity-only code). */
  loadMqtt: async (): Promise<typeof import("mqtt")> => import("mqtt"),
};

/**
 * Serialize a payload for the wire.
 *
 * Identical rule to kafkaPublish, for the identical reason: a string goes out VERBATIM, because an
 * author who has already produced JSON — or is publishing a bare number to a sensor topic — would
 * otherwise get their payload silently double-encoded. `undefined`/`null` become an EMPTY buffer,
 * which in MQTT is how a retained message is cleared: publishing a zero-length payload with
 * `retain` deletes the topic's retained value. That is a real operation, so it is preserved rather
 * than rejected.
 */
function serializePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

/**
 * Reject a topic a broker will reject anyway, with a message that says why.
 *
 * `+` and `#` are SUBSCRIPTION wildcards; publishing to them is illegal in MQTT and most brokers
 * answer by closing the connection rather than by explaining. An author who typed a filter into a
 * publish node would otherwise see a bare disconnect.
 */
function assertPublishableTopic(topic: string): void {
  if (!topic.trim()) {
    throw ApplicationFailure.nonRetryable(
      "mqttPublish needs a topic.",
      "MQTT_CONFIG",
    );
  }
  if (topic.includes("+") || topic.includes("#")) {
    throw ApplicationFailure.nonRetryable(
      `MQTT topic '${topic}' contains a wildcard. '+' and '#' are for subscribing — a publish must name one exact topic.`,
      "MQTT_CONFIG",
    );
  }
}

/**
 * Publish ONE message to an MQTT topic.
 *
 * SSRF (audit #597): the broker host is tenant-supplied, exactly like a SQL DSN host or a Kafka
 * broker, so it goes through `resolvePinnedHost` — resolve once, reject private/reserved ranges,
 * pin the address. Without it a "connection" pointed at 10.0.0.x is a port scanner against our own
 * infrastructure.
 *
 * AT-MOST-ONCE, like kafkaPublish and for the same reason: the proxy is `maximumAttempts: 1`, so a
 * publish that fails fails the node rather than risking a duplicate. A QoS-1 publish whose PUBACK
 * is lost may well have been delivered, and retrying would send it twice — MQTT's own at-least-once
 * guarantee is about the BROKER's redelivery, not about ours.
 *
 * `qos` defaults to 1 rather than 0 because at QoS 0 the broker sends no acknowledgement at all: a
 * publish that vanished into a half-open socket completes successfully here and nobody ever knows.
 */
export async function callMqttPublish(
  cfg: MqttPublishActivityConfig,
  _input: unknown,
  meta: AgentMeta,
): Promise<MqttPublishResult> {
  assertPublishableTopic(cfg.topic ?? "");

  let conn;
  try {
    conn = await __mqttDeps.resolveMqttConnection(
      meta.tenantId,
      cfg.connectionId,
    );
  } catch (e) {
    // A missing/!mqtt/malformed connection is the author's to fix — retrying re-reads the same row
    // and fails identically, so burn no Temporal retries on it.
    throw ApplicationFailure.nonRetryable(
      e instanceof MissingConnectionTokenError
        ? "This MQTT connection has no stored configuration yet."
        : (e as Error).message,
      "MQTT_CONNECTION",
      { tenantId: meta.tenantId },
    );
  }

  // Pin the host BEFORE connecting, so a blocked address fails before any socket is opened.
  //
  // And keep the ORIGINAL hostname as the TLS servername. Rewriting the URL to the pinned IP is
  // the whole point — it is what DNS rebinding cannot defeat — but it also removes the name TLS
  // validates against, so an `mqtts://` broker with a certificate for its hostname (the ordinary
  // case) would fail to verify, or worse, be validated against the address. `smtp-pin.ts` documents
  // exactly this trap for nodemailer; the same one applies here.
  const url = new URL(conn.url);
  const originalHost = url.hostname;
  try {
    const pinned = await __mqttDeps.resolvePinnedHost(url.hostname);
    url.hostname = pinned;
  } catch (e) {
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        // Names the host so the author can fix it; carries no credential.
        `MQTT broker '${originalHost}' isn't allowed — brokers must be public hosts (private/reserved addresses are blocked).`,
        "MQTT_EGRESS_BLOCKED",
      );
    }
    throw e;
  }

  const mqtt = await __mqttDeps.loadMqtt();
  // Only for the TLS schemes, and never when the configured host was ALREADY an IP literal: there
  // is no name to validate against there, and asserting one would be a claim the certificate
  // cannot satisfy. Mirrors smtp-pin's "IP-literal host returned unchanged".
  const isTls = url.protocol === "mqtts:" || url.protocol === "wss:";
  const hostWasIp = originalHost === url.hostname;
  const servername = isTls && !hostWasIp ? originalHost : undefined;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const qos = cfg.qos ?? 1;
  const retain = cfg.retain ?? false;

  const client = await mqtt.connectAsync(url.toString(), {
    username: conn.username,
    password: conn.password,
    ...(conn.clientId ? { clientId: conn.clientId } : {}),
    // TLS cert validation stays on the NAME even though the socket dials the pinned address.
    ...(servername ? { servername } : {}),
    // A PUBLISH-only client must not resume anything: `clean: true` tells the broker to discard any
    // session state for this client id. The persistent-session behaviour belongs to the trigger
    // (slice 3b), and inheriting it here would have a publish quietly collect a subscriber's
    // undelivered backlog.
    clean: true,
    connectTimeout: timeoutMs,
    // One attempt. Reconnecting inside the activity would turn a failed publish into an
    // indefinite hang, and Temporal's own retry policy is the layer that decides about retries.
    reconnectPeriod: 0,
  });

  try {
    await client.publishAsync(cfg.topic, serializePayload(cfg.payload), {
      qos,
      retain,
    });
    return {
      status: "ok",
      // What was SENT. MQTT hands a publisher no message identity — QoS 0 is unacknowledged and
      // QoS 1/2 confirm only the handshake — so inventing one would invite correlation logic the
      // protocol cannot support.
      output: { topic: cfg.topic, qos, retained: retain },
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    const message = (e as Error)?.message ?? "";
    // A rejected credential fails the same way twice; everything else (broker restarting, network)
    // is genuinely transient and SHOULD retry. The message never echoes the broker's, which can
    // carry the URL and username.
    if (/Not authorized|Bad username or password|auth/i.test(message)) {
      throw ApplicationFailure.nonRetryable(
        "The MQTT broker refused the connection's credentials, or the topic is not authorized for them.",
        "MQTT_AUTH",
        { tenantId: meta.tenantId },
      );
    }
    throw e;
  } finally {
    // Always end the client: a leaked connection holds a broker session slot for the life of the
    // worker, and brokers commonly cap connections per credential. `force: false` lets an
    // in-flight QoS-1 PUBACK settle first.
    try {
      await client.endAsync(false);
    } catch {
      /* best-effort teardown */
    }
  }
}
