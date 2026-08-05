// Passthrough / entry-node leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE.
import * as wf from "@temporalio/workflow";
import type { NodeOutputMap } from "@naary/dsl";
import type { NodeHandler } from "./contract";

// end: a pure no-op. It is the terminal passthrough — it genuinely has no output, and the
// run-detail view says so in those words rather than "no output was recorded".
export const handlePassthroughNull: NodeHandler = async () => {
  return;
};

/**
 * `start` — the manual/API entry node, and THE entry a sub-workflow uses (a child run is
 * called by its parent, so it is not webhook/schedule/form-triggered).
 *
 * It used to be `handlePassthroughNull`, i.e. it wrote nothing to ctx. Every OTHER entry node
 * publishes the run input as its own output (`ctx[node.id] = ctx.__input`) — six of the seven
 * do it, and even `noOp` writes `{}` specifically so "routing an edge through here doesn't
 * break any binding". `start` was simply missed.
 *
 * The consequence is worst exactly where it matters most. `executeSubWorkflow` hands the child
 * its input, which lands at the child's `__input` — but with no `ctx.start`, nothing in the
 * child graph can BIND to it: `getByPath(ctx["start"], path)` is `undefined`, so a binding the
 * canvas happily offers (upstreamOf includes entry nodes) silently reads nothing. Reported as
 * "the data is not being passed correctly between the workflows". The data was arriving; it had
 * no name to be read by.
 *
 * patched() because this can change behaviour, not just add data: an edge condition reading
 * `start.*` currently evaluates against `undefined` and would now see a real value, which can
 * route an in-flight run down a different branch — a different command sequence, i.e. a
 * nondeterminism error on replay. New runs get the fix; runs already in flight replay unchanged.
 */
export const handleStart: NodeHandler = async ({ node, ctx }) => {
  if (wf.patched("start-node-input-v1")) ctx[node.id] = ctx.__input;
  return;
};

export const handleWebhookTrigger: NodeHandler = async ({ node, ctx }) => {
  // Slice #4: the inbound event (the workflow input) is this node's output.
  ctx[node.id] = ctx.__input;
  return;
};

/**
 * `kafkaTrigger` — one run per Kafka message (#1086 slice 2).
 *
 * Shaped like `webhookTrigger`, NOT like `pollTrigger`: the data arrives WITH the run (the drain
 * workflow passes the message as the run input) rather than being fetched here. A handler that
 * fetched would be a second consumer, outside the drain's offset accounting.
 *
 * `satisfies` anchors the projection to the declared output shape, so a change to what the drain
 * sends fails to compile here rather than silently reaching authors' bindings as `undefined`.
 */
export const handleKafkaTrigger: NodeHandler = async ({ node, ctx }) => {
  ctx[node.id] = ctx.__input as NodeOutputMap["kafkaTrigger"];
  return;
};

/**
 * `mqttTrigger` — one run per MQTT message (#1086 slice 3b).
 *
 * Same shape and same reason as `handleKafkaTrigger`: the message arrives WITH the run, passed as
 * the run input by the drain workflow. A handler that subscribed here would be a second subscriber
 * outside the drain's session — which, MQTT being what it is, would not merely double-read but take
 * the session over from the drain (a client id can only be connected once).
 */
export const handleMqttTrigger: NodeHandler = async ({ node, ctx }) => {
  ctx[node.id] = ctx.__input as NodeOutputMap["mqttTrigger"];
  return;
};

export const handleScheduleTrigger: NodeHandler = async ({ node, ctx }) => {
  // Entry node: the run was started by a Temporal cron Schedule (control-plane synced
  // on save). Passthrough of the run input — the schedule carries no external event.
  ctx[node.id] = ctx.__input;
  return;
};

export const handleFormTrigger: NodeHandler = async ({ node, ctx }) => {
  // Entry node: the run was started by a hosted form submission (a later slice adds the
  // public endpoint). The submitted fields ARE the run input → this node's output.
  ctx[node.id] = ctx.__input;
  return;
};

export const handleChatTrigger: NodeHandler = async ({ node, ctx }) => {
  // Entry node: the run was started by a hosted chat message (public endpoint + durable
  // session are later slices). The inbound { message, sessionId } IS the run input.
  ctx[node.id] = ctx.__input;
  return;
};

export const handleMcpServerTrigger: NodeHandler = async ({ node, ctx }) => {
  // Entry node: the run was started by an external MCP client invoking this workflow's hosted
  // tool (the API's /mcp endpoint maps the tool-call arguments to the run input). The invocation
  // args ARE the run input → this node's output (like webhookTrigger's output IS the event).
  ctx[node.id] = ctx.__input;
  return;
};

export const handleErrorTrigger: NodeHandler = async ({ node, ctx }) => {
  // Entry node of an error-handler graph — its output is the failure context
  // the interpreter passed as this run's input.
  ctx[node.id] = ctx.__input;
  return;
};

export const handleNoOp: NodeHandler = async ({ node, ctx }) => {
  // Does nothing — a structural/placeholder node. Emits {} (downstream nodes bind to real
  // upstream node ids, so routing an edge through here doesn't break any binding).
  ctx[node.id] = {};
  return;
};
