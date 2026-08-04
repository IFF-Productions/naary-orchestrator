// Kafka scheduled drain (#1086 slice 2) — the workflow a `kafkaTrigger` graph's Temporal interval
// Schedule fires. It consumes a bounded batch, starts ONE runGraph child per message, and only
// then commits the offsets.
//
// DETERMINISTIC TEMPORAL WORKFLOW CODE (CLAUDE.md Tier-1): no I/O, no wall clock, no randomness.
// The broker work is in activities; this module decides what runs and under which id.
import * as wf from "@temporalio/workflow";
// From @temporalio/common, not the workflow barrel: the barrel re-exports a fixed list of failure
// classes and this one is not on it. `instanceof` still works across package copies — the class is
// tagged with SymbolBasedInstanceOfError for exactly that reason — so this is a safe import, and
// the version is pinned to the same ^1.21.1 as every other @temporalio/* (a skew here once took
// the API down on boot).
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import type { GraphDef } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic bundle.
import type * as activities from "../activities";
import { runGraph } from "./run-graph";
import type { RunGraphCtx } from "./types";

export interface KafkaDrainInput {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  /** The VERSION-PINNED graph every message's run executes — resolved by the control plane when
   *  the schedule was synced, exactly like the poll/cron path. */
  graph: GraphDef;
  graphContentHash: string;
  graphVersion: number;
  /** Resolved from the graph's kafkaTrigger node at sync time. */
  connectionId: string;
  topic: string;
  groupId: string;
  maxMessages?: number;
  maxWaitMs?: number;
  fromBeginning?: boolean;
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
}

export interface KafkaDrainResult {
  /** Messages taken off the topic this drain. */
  drained: number;
  /** Runs actually STARTED — lower than `drained` when a redelivery was deduped away. */
  started: number;
  /** Redeliveries that hit an existing workflowId and did nothing. The whole design in one number. */
  deduped: number;
  /** Set when a bound stopped the drain early, so a growing backlog is visible rather than
   *  indistinguishable from an empty topic. */
  stoppedAt: activities.KafkaConsumeResult["stoppedAt"];
}

// The drain is at-most-once per SCHEDULE FIRING on purpose: if the consume fails, the next interval
// tries again, and nothing was committed. Long-ish timeout because a drain waits `maxWaitMs` for
// messages by design.
const { callKafkaConsume, callKafkaCommit } = wf.proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * The message's identity, as a Temporal workflowId.
 *
 * `(topic, partition, offset)` is what makes a redelivery recognisable, and the tenant/env/workflow
 * prefix is what keeps it unique: workflowIds are NAMESPACE-global, and topic names are
 * tenant-supplied, so `kafka:orders:0:41` alone would collide across tenants — one tenant's
 * redelivery would silently suppress another tenant's first delivery.
 *
 * Sanitized and length-bounded because none of these segments is guaranteed id-safe.
 */
export function kafkaRunId(p: {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  topic: string;
  partition: number;
  offset: string;
}): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const head = `kafka-${safe(p.tenantId)}-${safe(p.environmentId)}-${safe(p.workflowKey)}`;
  const tail = `${safe(p.topic)}-${p.partition}-${p.offset}`;
  // Temporal's workflowId limit is 1000 bytes; stay well inside it while keeping the tail — the
  // part that carries the identity — whole. Truncating the HEAD is safe (it is a constant prefix
  // per graph); truncating the tail would merge two different messages into one id.
  return `${head.slice(0, 200)}-${tail}`.slice(0, 400);
}

/**
 * One drain: consume → start a run per message → commit.
 *
 * THE ORDERING IS THE DESIGN. Committing before the runs are started would lose messages on a
 * crash; committing after means a crash REDELIVERS them, which is harmless because the run's id is
 * derived from the message's identity.
 *
 * DEDUPE, precisely. `workflowIdReusePolicy: REJECT_DUPLICATE` is set explicitly and is NOT the
 * default — Temporal defaults to ALLOW_DUPLICATE, which only rejects an id whose prior execution is
 * still RUNNING. A redelivered Kafka message almost always arrives after its run has finished, so
 * the default would happily start a second one. #1086 described this as "a no-op by construction";
 * that is only true with this policy set.
 *
 * The guarantee is bounded by NAMESPACE RETENTION: once a closed execution ages out, Temporal has
 * no memory of the id and a redelivery would run again. That is a real limit, stated rather than
 * implied — it is measured in days, and redeliveries are measured in seconds.
 *
 * `startChild`, not `executeChild`: the drain must not wait for the runs. A graph that pauses for a
 * human approval would otherwise hold the drain — and its consumer group — open for days.
 * `ABANDON`, because the drain closes long before the runs it started (the default is TERMINATE,
 * which would kill every run the moment the drain finished).
 */
export async function kafkaDrain(
  input: KafkaDrainInput,
): Promise<KafkaDrainResult> {
  const { messages, stoppedAt } = await callKafkaConsume(
    {
      connectionId: input.connectionId,
      topic: input.topic,
      groupId: input.groupId,
      maxMessages: input.maxMessages,
      maxWaitMs: input.maxWaitMs,
      fromBeginning: input.fromBeginning,
    },
    { tenantId: input.tenantId, environmentId: input.environmentId } as never,
  );

  if (messages.length === 0) {
    return { drained: 0, started: 0, deduped: 0, stoppedAt };
  }

  let started = 0;
  let deduped = 0;
  for (const m of messages) {
    const workflowId = kafkaRunId({
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      workflowKey: input.workflowKey,
      topic: m.topic,
      partition: m.partition,
      offset: m.offset,
    });
    try {
      await wf.startChild(runGraph, {
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        parentClosePolicy: "ABANDON",
        args: [
          input.graph,
          // The message IS the run's input, exactly as a webhook body is. The trigger node projects
          // it into ctx; nothing else has to know where the run came from.
          m,
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
      // The dedupe firing is SUCCESS, not failure: this exact message already has a run. Counted
      // rather than swallowed, so "redelivery is a no-op" is something the run history shows
      // instead of something the design claims.
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        deduped++;
        continue;
      }
      throw e;
    }
  }

  // Commit AFTER the starts. Per partition, the next offset to read is one past the highest we
  // took — and the consume activity guarantees a contiguous prefix per partition, so this cannot
  // step over a message it declined to take.
  const next = new Map<number, bigint>();
  for (const m of messages) {
    const candidate = BigInt(m.offset) + 1n;
    const seen = next.get(m.partition);
    if (seen === undefined || candidate > seen)
      next.set(m.partition, candidate);
  }
  await callKafkaCommit(
    {
      connectionId: input.connectionId,
      topic: input.topic,
      groupId: input.groupId,
      offsets: [...next.entries()].map(([partition, offset]) => ({
        partition,
        // A STRING, and computed with BigInt: Kafka offsets are int64, and a busy topic passes
        // Number.MAX_SAFE_INTEGER — at which point `+ 1` silently stops advancing and the drain
        // replays the same message forever.
        offset: offset.toString(),
      })),
    },
    { tenantId: input.tenantId, environmentId: input.environmentId } as never,
  );

  return { drained: messages.length, started, deduped, stoppedAt };
}
