// Passthrough / entry-node leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE.
import type { NodeHandler } from "./contract";

// start / end: pure no-ops.
export const handlePassthroughNull: NodeHandler = async () => {
  return;
};

export const handleWebhookTrigger: NodeHandler = async ({ node, ctx }) => {
  // Slice #4: the inbound event (the workflow input) is this node's output.
  ctx[node.id] = ctx.__input;
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
