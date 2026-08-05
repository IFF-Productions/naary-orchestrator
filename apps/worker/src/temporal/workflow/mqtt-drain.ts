// MQTT scheduled drain (#1086 slice 3b) — the workflow an `mqttTrigger` graph's Temporal interval
// Schedule fires. It drains a bounded batch over the trigger's PERSISTENT SESSION and starts ONE
// runGraph child per message.
//
// Structurally the twin of kafka-drain.ts; semantically its inverse, in the two places that matter:
// there is no commit step, and the run's workflowId is NOT a dedupe key. Both are explained below
// rather than left for a reader to infer from the missing code.
//
// DETERMINISTIC TEMPORAL WORKFLOW CODE (CLAUDE.md Tier-1): no I/O, no wall clock, no randomness.
// The broker work is in activities; this module decides what runs and under which id.
import * as wf from "@temporalio/workflow";
// From @temporalio/common, not the workflow barrel — see the same import in kafka-drain.ts for why
// (the barrel re-exports a fixed list of failure classes and this one is not on it).
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import type { GraphDef } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic bundle.
import type * as activities from "../activities";
import { runGraph } from "./run-graph";
import type { RunGraphCtx } from "./types";

export interface MqttDrainInput {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  /** The VERSION-PINNED graph every message's run executes — resolved by the control plane when
   *  the schedule was synced, exactly like the poll/cron/kafka paths. */
  graph: GraphDef;
  graphContentHash: string;
  graphVersion: number;
  /** Resolved from the graph's mqttTrigger node at sync time. */
  connectionId: string;
  topic: string;
  qos?: 0 | 1;
  maxMessages?: number;
  maxWaitMs?: number;
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
}

export interface MqttDrainResult {
  /** Messages taken off the session this drain. */
  drained: number;
  /** Runs actually STARTED. */
  started: number;
  /**
   * Starts that hit an existing workflowId and did nothing.
   *
   * NOT the Kafka counter's meaning. There, a non-zero `deduped` is the design working — a
   * redelivered message being turned into a no-op. Here it can only be a workflow REPLAY
   * re-issuing a start it had already made, because the ids are unique per drain by construction.
   * A non-zero value is therefore unremarkable, and it is emphatically NOT evidence that MQTT
   * redelivery is being deduped. It is not.
   */
  deduped: number;
  /** The broker's answer to "did you still have my session?" — see MqttConsumeResult. `false` on
   *  anything but a first drain means a queued backlog was discarded by the broker. */
  sessionPresent: boolean;
  /** Retained values the broker replayed for a subscription we already had, and the drain dropped. */
  droppedRetainedReplays: number;
  /** Set when a bound stopped the drain early. `null` means only "nothing more arrived in the
   *  window" — MQTT cannot report an empty backlog. */
  stoppedAt: activities.MqttConsumeResult["stoppedAt"];
}

const { callMqttConsume } = wf.proxyActivities<typeof activities>({
  // A drain waits `maxWaitMs` for messages by design, so the timeout is generous.
  startToCloseTimeout: "2 minutes",
  // ONE ATTEMPT — the opposite of the Kafka drain's `maximumAttempts: 3`, and the difference is
  // the ack. A retried Kafka consume re-reads the very same messages, because nothing is committed
  // until after the runs are started; retrying there costs a round trip and risks nothing.
  //
  // Here the activity has already PUBACKed everything it took, so the broker will not send those
  // messages again. A second attempt therefore cannot see them — it drains only what is left, and
  // if it succeeds the drain returns a green result for a batch that is missing the messages the
  // first attempt acknowledged. That turns a visible failure into silent loss, which is precisely
  // the failure mode this slice is documented as avoiding.
  //
  // Failing loudly costs nothing: unacknowledged messages stay queued in the persistent session,
  // so the next scheduled drain picks them up (proven against a real broker in
  // mqtt-drain.integration.spec.ts). A failed drain loses nothing that was not already lost.
  retry: { maximumAttempts: 1 },
});

/**
 * The client id the broker keys this trigger's PERSISTENT SESSION on.
 *
 * Everything about resuming depends on this string being byte-identical from one drain to the
 * next: the broker holds the subscription and the queued QoS-1 messages against it, and hands them
 * over at the next connect. A changed id starts a fresh, empty session and abandons the old one's
 * backlog without a word.
 *
 * WHY THE TOPIC AND QOS ARE IN IT. A session carries its SUBSCRIPTIONS, and SUBSCRIBE adds rather
 * than replaces. If an author edited the filter from `sensors/+` to `devices/+` while keeping the
 * session, the old filter would still be subscribed and its messages would keep arriving forever.
 * Folding the filter into the identity means editing it starts a clean session that is subscribed
 * to exactly what the graph now says. The cost is real and worth stating: the abandoned session
 * lingers on the tenant's broker until their own expiry policy reaps it (mosquitto's
 * `persistent_client_expiration` is unset by default, i.e. never).
 *
 * WHY IT IS AN OPAQUE HASH, and why an author cannot override it. MQTT 3.1.1 only requires brokers
 * to accept client ids of 1–23 characters, so a readable `naary-<tenant>-<env>-<workflowKey>-…`
 * would have to be truncated — and a truncation collision here is not a cosmetic clash: two
 * triggers sharing a client id take each other's session over on every connect, each inheriting
 * the other's queued messages, and MQTT's answer to a duplicate connect is to DISCONNECT the
 * incumbent. `naary-` + 16 hex is 22 characters and always fits. An author-supplied override was
 * considered and rejected for the same reason, plus a sharper one: an override that happened to
 * match the connection's own `clientId` would have every `mqttPublish` (`clean: true`) destroy
 * this trigger's session and everything queued in it.
 *
 * The hash is FNV-1a, computed inline: it is pure arithmetic and so safe in deterministic workflow
 * code, where `node:crypto` is neither available nor needed (this is an identity, not a secret).
 */
export function mqttSessionClientId(p: {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  topic: string;
  qos: 0 | 1;
}): string {
  const material = `${p.tenantId}|${p.environmentId}|${p.workflowKey}|${p.topic}|${p.qos}`;
  // Two independently-seeded 32-bit FNV-1a passes rather than one, so the id is 64 bits wide. At
  // 32 bits a few tens of thousands of triggers would make a collision likely, and a collision is
  // the session-takeover failure above.
  const fnv = (seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < material.length; i++) {
      h ^= material.charCodeAt(i);
      // The FNV prime (16777619) via shifts — `h * 16777619` loses precision past 2^53.
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `naary-${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
}

/**
 * A run's workflowId — and it is UNIQUENESS, not dedupe. This is the honest difference from Kafka.
 *
 * Kafka's id is `(topic, partition, offset)`: a redelivery derives the SAME id, Temporal rejects
 * it, and "redelivery is a no-op" holds by construction. MQTT hands us nothing to build that from.
 * Its only per-message token is a `packetId`, which is scoped to one session and RE-USED the
 * moment it is acknowledged — so two unrelated messages minutes apart routinely share one. Keying
 * runs on it would silently drop the second message as a "duplicate", and the same objection sinks
 * a content hash: a sensor publishing `{"on":true}` twice is two events, not one, and collapsing
 * them is data LOSS, which is a far worse failure than a duplicate run.
 *
 * So this id is built from the DRAIN'S RUN ID plus the message's index within that drain. What
 * that buys, exactly:
 *
 *  - Two distinct messages NEVER collapse into one run. That is the failure worth engineering
 *    against, and it is guaranteed rather than probable.
 *  - It is stable under REPLAY. A drain whose workflow task fails midway re-derives the identical
 *    ids, so the starts it already made are recognised — which is why `REJECT_DUPLICATE` is still
 *    set below even though there is no cross-drain dedupe to do.
 *
 * What it does NOT buy, stated plainly: if the same message is ever delivered to two successful
 * drains — a PUBACK lost in flight, so the broker redelivers with DUP set — that produces TWO
 * runs, and nothing here prevents it. The message's `dup` flag is the only signal an author gets,
 * and it is surfaced in the trigger's output for exactly that reason.
 *
 * `runId` rather than the drain's workflowId: a schedule that retries a failed drain reuses the
 * workflowId, so ids built from it would collide across attempts and suppress genuinely new
 * messages. The tenant/env/workflow prefix is cosmetic — a runId is already globally unique — but
 * it makes a run searchable by the trigger it came from.
 */
export function mqttRunId(p: {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  drainRunId: string;
  index: number;
}): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const head = `mqtt-${safe(p.tenantId)}-${safe(p.environmentId)}-${safe(p.workflowKey)}`;
  const tail = `${safe(p.drainRunId)}-${p.index}`;
  // Temporal's limit is 1000 bytes; stay well inside it. Truncating the HEAD is safe (it is a
  // constant prefix per graph); truncating the TAIL would merge two different messages into one id.
  return `${head.slice(0, 200)}-${tail}`.slice(0, 400);
}

/**
 * One drain: consume (and acknowledge) → start a run per message.
 *
 * THERE IS NO COMMIT STEP, and its absence is the whole story of this slice. Kafka's drain commits
 * offsets AFTER the runs are started, so a crash in between redelivers and the offset-derived
 * workflowId makes the redelivery a no-op. MQTT cannot be arranged that way: an acknowledgement
 * belongs to the connection that received the message, and mqtt.js sends the PUBACK from the same
 * callback that pumps its packet parser, so an ack cannot outlive the consume activity (see
 * `callMqttConsume`).
 *
 * THE GUARANTEE IS THEREFORE THE MIRROR OF KAFKA'S — duplicates are rare, loss is possible — and
 * the loss window is specific rather than vague: the worker dies, or the activity's result fails
 * to reach Temporal, in the moment between the broker receiving the PUBACKs and the activity
 * completing. Those messages are acknowledged, so the broker will not send them again, and no run
 * was ever started for them. It is a window of milliseconds and it is real.
 *
 * Everything around that window is arranged to keep it from growing:
 *
 *  - The consume activity is NOT RETRIED (see the proxy above). A retry cannot re-read an
 *    acknowledged message, so a second attempt that succeeded would return a batch missing
 *    whatever the first attempt acked — a green result hiding a loss.
 *  - A drain that fails part-way still RETURNS what it acknowledged, flagged `stoppedAt.reason:
 *    "error"`, and the runs below are started for it. Throwing that batch away would be the same
 *    loss, just earlier.
 *  - Messages the drain never took are never acknowledged, so they stay queued in the session and
 *    arrive at the next drain. That is the recovery path a failed drain relies on, and it is
 *    verified against a real broker rather than assumed.
 *
 * `startChild`, not `executeChild`: the drain must not wait for the runs — a graph that pauses for
 * a human approval would otherwise hold the drain (and the broker session) open for days.
 * `ABANDON`, because the drain closes long before the runs it started, and the default
 * (TERMINATE) would kill every one of them the moment it did.
 */
export async function mqttDrain(
  input: MqttDrainInput,
): Promise<MqttDrainResult> {
  const qos = input.qos ?? 1;
  const clientId = mqttSessionClientId({
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    workflowKey: input.workflowKey,
    topic: input.topic,
    qos,
  });

  const { messages, sessionPresent, droppedRetainedReplays, stoppedAt } =
    await callMqttConsume(
      {
        connectionId: input.connectionId,
        topic: input.topic,
        clientId,
        qos,
        maxMessages: input.maxMessages,
        maxWaitMs: input.maxWaitMs,
      },
      { tenantId: input.tenantId, environmentId: input.environmentId } as never,
    );

  const base = {
    drained: messages.length,
    sessionPresent,
    droppedRetainedReplays,
    stoppedAt,
  };
  if (messages.length === 0) {
    return { ...base, started: 0, deduped: 0 };
  }

  // Deterministic: `runId` is fixed for this execution and replays identically.
  const drainRunId = wf.workflowInfo().runId;
  let started = 0;
  let deduped = 0;
  for (const [index, message] of messages.entries()) {
    const workflowId = mqttRunId({
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      workflowKey: input.workflowKey,
      drainRunId,
      index,
    });
    try {
      await wf.startChild(runGraph, {
        workflowId,
        // Not load-bearing for cross-drain dedupe (there is none) but load-bearing for REPLAY:
        // Temporal's default, ALLOW_DUPLICATE, only rejects an id whose prior execution is still
        // running, so a re-issued start after a workflow-task failure could launch a second run of
        // a message that already has one.
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        parentClosePolicy: "ABANDON",
        args: [
          input.graph,
          // The message IS the run's input, exactly as a webhook body is. The trigger node projects
          // it into ctx; nothing else has to know where the run came from.
          message,
          {
            tenantId: input.tenantId,
            environmentId: input.environmentId,
            workflowKey: input.workflowKey,
            perExecutionCapUsd: input.perExecutionCapUsd,
            maxStepsPerRun: input.maxStepsPerRun,
            graphContentHash: input.graphContentHash,
            graphVersion: input.graphVersion,
          } satisfies RunGraphCtx,
        ],
      });
      started++;
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        deduped++;
        continue;
      }
      throw e;
    }
  }

  return { ...base, started, deduped };
}
