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
 * Read the connection and put its broker host through the egress guard, returning a URL that is
 * safe to dial plus the TLS name to validate against.
 *
 * SHARED BY PUBLISH AND CONSUME DELIBERATELY — the same call `connectKafka` makes, for the same
 * reason. These are the two places a tenant-supplied broker host and stored credentials are
 * handled, and they are exactly the two that must not drift: a consume path that forgot to pin
 * would be an SSRF hole reachable from a saved workflow, and it would review as fine because the
 * publish path above it does it correctly.
 *
 * What is NOT shared is the client OPTIONS. `clean`, `clientId` and the protocol version are where
 * publishing and subscribing genuinely disagree (see each call site), and folding them in here
 * would produce one function with a flag whose two branches have opposite session semantics.
 *
 * SSRF (audit #597): the broker host is tenant-supplied, exactly like a SQL DSN host or a Kafka
 * broker, so it goes through `resolvePinnedHost` — resolve once, reject private/reserved ranges,
 * pin the address. Without it a "connection" pointed at 10.0.0.x is a port scanner against our own
 * infrastructure.
 */
async function resolvePinnedMqttTarget(
  connectionId: string,
  meta: AgentMeta,
): Promise<{
  conn: Awaited<ReturnType<typeof resolveMqttConnection>>;
  /** The dial URL, hostname replaced by the pinned address. */
  url: string;
  /** TLS servername to assert, or undefined when there is no name to assert. */
  servername: string | undefined;
}> {
  let conn;
  try {
    conn = await __mqttDeps.resolveMqttConnection(meta.tenantId, connectionId);
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

  // Only for the TLS schemes, and never when the configured host was ALREADY an IP literal: there
  // is no name to validate against there, and asserting one would be a claim the certificate
  // cannot satisfy. Mirrors smtp-pin's "IP-literal host returned unchanged".
  const isTls = url.protocol === "mqtts:" || url.protocol === "wss:";
  const hostWasIp = originalHost === url.hostname;
  return {
    conn,
    url: url.toString(),
    servername: isTls && !hostWasIp ? originalHost : undefined,
  };
}

/**
 * Classify a broker error — shared by every MQTT activity.
 *
 * A rejected credential fails the same way twice; everything else (broker restarting, network) is
 * genuinely transient and SHOULD retry. The message never echoes the broker's, which can carry the
 * URL and username (Tier-1 §4).
 */
function classifyMqttError(e: unknown, meta: AgentMeta): unknown {
  const message = (e as Error)?.message ?? "";
  if (/Not authorized|Bad username or password|auth/i.test(message)) {
    return ApplicationFailure.nonRetryable(
      "The MQTT broker refused the connection's credentials, or the topic is not authorized for them.",
      "MQTT_AUTH",
      { tenantId: meta.tenantId },
    );
  }
  return e;
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

  const { conn, url, servername } = await resolvePinnedMqttTarget(
    cfg.connectionId,
    meta,
  );

  const mqtt = await __mqttDeps.loadMqtt();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const qos = cfg.qos ?? 1;
  const retain = cfg.retain ?? false;

  const client = await mqtt.connectAsync(url, {
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
    throw classifyMqttError(e, meta);
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

/* -------------------------------------------------------------------------- */
/* Consume side — the scheduled drain over a PERSISTENT SESSION (#1086 slice 3b) */
/* -------------------------------------------------------------------------- */

/** A resolved mqttTrigger drain. No secrets: the URL/credentials come from `connectionId`. */
export interface MqttConsumeActivityConfig {
  connectionId: string;
  /** Topic FILTER — wildcards allowed, unlike the publish side. */
  topic: string;
  /**
   * The SESSION's identity, derived by the drain workflow (`mqttSessionClientId`) rather than
   * chosen here or taken from the connection.
   *
   * This is the single most load-bearing string in the slice. The broker keys the persistent
   * session — the subscription and every QoS-1 message queued while we were away — on exactly
   * this value. If it changes, the old session and its backlog are abandoned; if two triggers
   * share it, each connect kicks the other off and inherits its queue.
   */
  clientId: string;
  qos?: 0 | 1;
  maxMessages?: number;
  maxWaitMs?: number;
}

/** One drained message. No id field — see `NodeOutputMap["mqttTrigger"]` for why. */
export interface MqttDrainedMessage {
  topic: string;
  payload: unknown;
  qos: number;
  retain: boolean;
  dup: boolean;
  receivedAt: string;
}

export interface MqttConsumeResult {
  messages: MqttDrainedMessage[];
  /**
   * The broker's CONNACK answer to "did you still have my session?".
   *
   * `false` on any drain but the first means the session was destroyed while we were away — a
   * broker restart without persistence, a session-expiry policy, or someone else connecting as
   * this client id — and everything queued for it was discarded. MQTT reports that in exactly one
   * place, this flag, and nowhere else; a drain that simply returns no messages looks identical.
   * So it is surfaced rather than dropped.
   */
  sessionPresent: boolean;
  /**
   * Retained messages the broker replayed for a subscription we ALREADY had, and which this drain
   * therefore discarded. Non-zero is normal and harmless; it is reported so the behaviour is
   * visible instead of looking like messages going missing. See the drop rule in `callMqttConsume`.
   */
  droppedRetainedReplays: number;
  /**
   * What ended the drain, and after how many messages.
   *
   * `"error"` means the broker connection failed PART-WAY THROUGH, after this drain had already
   * acknowledged the messages it is returning. They are handed back rather than thrown away (see
   * `callMqttConsume`), so this is the only signal that the batch is a survivor of a failure rather
   * than a clean read — without it, a half-drained batch is indistinguishable from a complete one.
   *
   * `null` means the broker sent nothing more for `maxWaitMs` — which is NOT the claim Kafka's
   * `null` makes. Kafka can say "the topic is exhausted"; MQTT has no queryable backlog, so all
   * this can honestly report is "nothing more arrived in the window". A quiet broker and a
   * silently-broken subscription look the same from here.
   */
  stoppedAt: {
    reason: "maxMessages" | "maxBytes" | "error";
    taken: number;
  } | null;
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_WAIT_MS = 5_000;
/**
 * Byte ceiling for ONE drain's returned batch — same reasoning as the Kafka drain's: Temporal's
 * ~2MB payload cap applies to this activity's RESULT, so `maxMessages` alone bounds nothing (50 ×
 * 100KB blows straight through it) and the failure would name a size rather than a topic.
 */
const MAX_BATCH_BYTES = 512 * 1024;

/** Body → payload. JSON when it parses, the raw string otherwise: a sensor topic carrying a bare
 *  number or a CSV line is not an error, so the parse is ATTEMPTED, never required. */
function parseMqttPayload(raw: Buffer | string): unknown {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (text === "") return null; // a zero-length body is legal MQTT (it is how a retain is cleared)
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Drain up to `maxMessages` from a topic filter over the trigger's PERSISTENT SESSION.
 *
 * ── How resuming works, and why it is nothing like Kafka's ────────────────────────────────────
 * There are no offsets to commit and no server-side log to seek in. The only state that survives
 * a disconnect is the broker's SESSION for our client id, so this connects with `clean: false`
 * and the caller's stable `clientId`. While no drain is running, the broker holds the
 * subscription and QUEUES matching QoS-1 messages against that session; they are delivered in a
 * burst at the next connect. `clean: true` — which the publish path above deliberately sets —
 * would tell the broker to throw all of that away, which is why the two clients are configured
 * separately instead of sharing one options object.
 *
 * `protocolVersion: 4` (MQTT 3.1.1) is PINNED, not inherited. Under 3.1.1 `clean: false` means
 * "keep my session" outright; under MQTT 5 the equivalent needs an explicit Session Expiry
 * Interval, and `cleanStart: false` with the default expiry of 0 destroys the session the moment
 * the socket closes. If mqtt.js ever changed its default version, an unpinned client would keep
 * connecting happily and silently stop resuming — and the symptom would be an empty drain, forever.
 *
 * ── The acknowledgement, and the guarantee that follows from it ───────────────────────────────
 * A taken message is PUBACKed AS IT ARRIVES. That is not a preference; mqtt.js gives no other
 * option. In its publish handler the PUBACK and the parser's continue-callback are the SAME
 * callback (`client.handleMessage(packet, cb)` → `cb()` sends the PUBACK *and* pumps the next
 * packet), so deferring the ack until after the runs are started would not delay an ack — it would
 * deadlock the client after exactly one message.
 *
 * So the ordering Kafka relies on — start the runs, THEN commit — is unavailable here, and the
 * guarantee is the mirror image of Kafka's: duplicates are rare and LOSS IS POSSIBLE. The window
 * is named in `mqttDrain`'s docstring rather than papered over.
 *
 * What we CAN do, and do: a message the drain declines to take is never acked. `cb(err)` skips the
 * PUBACK while still pumping the parser, so a refused message stays queued in the session and
 * comes back next drain. That is strictly better than the Kafka path's constraint — offsets forced
 * a contiguous prefix, whereas an unacked MQTT message can be left behind individually.
 *
 * ── Retained-message replay ───────────────────────────────────────────────────────────────────
 * A SUBSCRIBE makes the broker re-send every retained message matching the filter. We subscribe on
 * every drain (so a subscription lost to an ACL fix or a broker rebuild heals itself), which alone
 * would mean one duplicate run per interval, forever, for any topic holding a retained value. So
 * when the session was already present, a delivery with `retain: true` is discarded: MQTT 3.1.1
 * §3.3.1.3 requires a broker to set RETAIN to 0 when forwarding a live publish to an established
 * subscription, so `retain: true` can only be a subscribe-time replay of a value this session has
 * already seen. It is still acked — leaving it unacked would just have the broker send it again.
 */
export async function callMqttConsume(
  cfg: MqttConsumeActivityConfig,
  meta: AgentMeta,
): Promise<MqttConsumeResult> {
  if (!cfg.topic?.trim()) {
    throw ApplicationFailure.nonRetryable(
      "mqttTrigger needs a topic filter.",
      "MQTT_CONFIG",
    );
  }
  const { conn, url, servername } = await resolvePinnedMqttTarget(
    cfg.connectionId,
    meta,
  );
  const mqtt = await __mqttDeps.loadMqtt();
  const maxMessages = Math.max(
    1,
    Math.floor(cfg.maxMessages ?? DEFAULT_MAX_MESSAGES),
  );
  const maxWaitMs = Math.max(
    500,
    Math.floor(cfg.maxWaitMs ?? DEFAULT_MAX_WAIT_MS),
  );
  const qos = cfg.qos ?? 1;

  const client = mqtt.connect(url, {
    username: conn.username,
    password: conn.password,
    // The SESSION's id — never `conn.clientId`, which the publish path uses with `clean: true`.
    // Sharing one id between the two would have every publish destroy this trigger's session and
    // the backlog waiting in it.
    clientId: cfg.clientId,
    ...(servername ? { servername } : {}),
    // The one option inverted from the publish client, and the reason this is its own slice.
    clean: false,
    protocolVersion: 4,
    connectTimeout: DEFAULT_TIMEOUT_MS,
    // Unchanged from the publish client: one attempt. A reconnect loop inside an activity turns a
    // dead broker into an activity that hangs until its start-to-close timeout, and Temporal's
    // retry policy is the layer that decides about retrying.
    reconnectPeriod: 0,
    // We re-SUBSCRIBE explicitly below; mqtt.js replaying subscriptions on its own would re-trigger
    // the retained-message replay this function works to suppress.
    resubscribe: false,
    // Register the message handler BEFORE the socket opens. A persistent session's backlog starts
    // arriving immediately after CONNACK — before our SUBSCRIBE is even sent — so a handler
    // installed after connecting would miss the first burst.
    manualConnect: true,
  });

  const messages: MqttDrainedMessage[] = [];
  let stoppedAt: MqttConsumeResult["stoppedAt"] = null;
  let droppedRetainedReplays = 0;
  let bytes = 0;
  let accepting = true;
  let sessionPresent = false;
  let finish = (): void => undefined;
  /** A broker failure seen AFTER the connect succeeded — see the durable listener below. */
  let midDrainError: unknown = null;

  // `done()` sends the PUBACK and pumps the parser; `done(err)` skips the PUBACK and still pumps
  // the parser. Both keep the client alive — NOT calling it at all is what stalls it.
  const KEEP_QUEUED = new Error("not taken by this drain");

  client.handleMessage = (packet, done) => {
    if (packet.cmd !== "publish") {
      done();
      return;
    }
    if (!accepting) {
      // A bound already ended the drain. Leave it unacked so the session keeps it for next time.
      done(KEEP_QUEUED);
      return;
    }
    // The subscribe-replay drop (see the docstring). ACKED, not refused: an unacked replay just
    // comes back, and it is not a message anyone lost.
    if (packet.retain && sessionPresent) {
      droppedRetainedReplays++;
      done();
      return;
    }
    const size =
      typeof packet.payload === "string"
        ? Buffer.byteLength(packet.payload)
        : (packet.payload?.length ?? 0);
    // The first message is ALWAYS taken, however large. Refusing it would leave it at the head of
    // the session queue to be refused again on every future drain — a permanently wedged trigger.
    if (messages.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      accepting = false;
      stoppedAt = { reason: "maxBytes", taken: messages.length };
      done(KEEP_QUEUED);
      finish();
      return;
    }
    bytes += size;
    messages.push({
      topic: packet.topic,
      payload: parseMqttPayload(packet.payload),
      qos: packet.qos,
      retain: packet.retain,
      dup: packet.dup,
      // Receipt time, not publish time — MQTT 3.1.1 puts no timestamp on the wire, and inventing
      // one that looked like the publisher's would be a lie a graph could branch on.
      receivedAt: new Date().toISOString(),
    });
    // ACK. From here the broker considers this message delivered and will not send it again.
    done();
    if (messages.length >= maxMessages) {
      accepting = false;
      stoppedAt = { reason: "maxMessages", taken: messages.length };
      finish();
    }
  };

  try {
    const connack = await new Promise<{ sessionPresent: boolean }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MQTT broker did not answer the connect.")),
          DEFAULT_TIMEOUT_MS,
        );
        client.once("connect", (packet) => {
          clearTimeout(timer);
          // Assigned HERE, not after the await. `resolve` only schedules a microtask, while
          // mqtt.js pumps subsequent packets through `nextTick` — whose queue drains first — so a
          // PUBLISH riding in the same TCP buffer as the CONNACK could reach `handleMessage` while
          // this was still false. Setting it in the handler makes "sessionPresent is known before
          // any packet is examined" an invariant rather than a matter of arrival timing.
          sessionPresent = packet.sessionPresent;
          resolve(packet);
        });
        client.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        client.connect();
      },
    );
    sessionPresent = connack.sessionPresent;

    // A DURABLE error listener, and it fixes a real hole. The connect promise's `once("error")` is
    // still attached at this point (it never fired), so a socket error AFTER the connect resolved
    // would be delivered to it and used to reject an already-settled promise — a no-op. The drain
    // would then sit out its full `maxWaitMs` and return its partial batch as an ordinary success,
    // with the broker failure reported precisely nowhere.
    client.on("error", (e) => {
      midDrainError = e;
      finish();
    });

    // AWAIT the SUBACK. A fire-and-forget subscribe followed by a disconnect can leave a session
    // holding no subscription at all — after which the broker queues nothing, every drain comes
    // back empty, and nothing anywhere reports an error.
    await client.subscribeAsync(cfg.topic, { qos });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      finish = () => {
        clearTimeout(timer);
        resolve();
      };
      // A bound may already have been hit, or the connection already failed, while the SUBACK was
      // in flight (the session's backlog arrives before it) — in which case nothing further would
      // ever call `finish`, so check now.
      if (!accepting || midDrainError) finish();
    });
    if (midDrainError) throw midDrainError;
  } catch (e) {
    // NEVER DISCARD AN ACKNOWLEDGED MESSAGE. Everything in `messages` has been PUBACKed, so the
    // broker considers it delivered and will not send it again. Throwing here would destroy those
    // messages outright: no run is ever started for them and no retry can recover them.
    //
    // The realistic path is not exotic. A persistent session's backlog starts arriving immediately
    // after CONNACK — before our SUBSCRIBE is even sent — so a `subscribeAsync` that fails has
    // usually already had messages acknowledged behind it.
    //
    // So a part-drained batch is RETURNED, flagged as ending in an error, and the drain workflow
    // starts runs for it. The messages that were never taken are unacknowledged and stay queued in
    // the session for the next drain. Nothing is lost either way.
    //
    // A failure with nothing taken still throws: there is nothing to preserve, and the drain should
    // fail visibly rather than report a clean empty read.
    if (messages.length === 0) throw classifyMqttError(e, meta);
    // Overwrites any bound already recorded: "the connection broke" is the more actionable of the
    // two, and a caller that sees `maxMessages` would reasonably assume a healthy, capped drain.
    stoppedAt = { reason: "error", taken: messages.length };
  } finally {
    // `false`, and it is load-bearing rather than tidy. The PUBACKs for everything this drain took
    // are only QUEUED by the time we get here; a forced close discards the unwritten ones, the
    // broker redelivers those messages on the next drain, and — MQTT having no message identity to
    // dedupe on — every one of them becomes a SECOND run. `end(false)` flushes first.
    try {
      await client.endAsync(false);
    } catch {
      /* best-effort teardown */
    }
  }

  return { messages, sessionPresent, droppedRetainedReplays, stoppedAt };
}
