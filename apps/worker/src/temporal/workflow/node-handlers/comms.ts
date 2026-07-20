// Email + sandboxed-code leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE: binding
// resolution is pure + in-workflow; the SMTP send / QuickJS execution run in the SAME
// activity proxies run-graph.ts uses. sendEmail returns its `costUsd` DELTA.
import { resolveSendEmail, asNodeConfig } from "@naary/dsl";
import type { NodeOutputMap } from "@naary/dsl";
import { callSendEmail, callCode } from "../proxies";
import type { NodeHandler } from "./contract";

export const handleSendEmail: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Binding resolution is deterministic (pure ctx read); the SMTP URI fetch +
  // send happen in the activity (URI/creds never enter workflow history).
  const emailCfg = asNodeConfig(cfg, "sendEmail");
  const result = await callSendEmail(
    resolveSendEmail(emailCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = {
    messageId: result.messageId,
  } satisfies NodeOutputMap["sendEmail"];
  return { costUsd: result.costUsd };
};

export const handleCode: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // Sandboxed user JS runs in the activity (QuickJS is non-deterministic).
  // Pass the entry input + a __-stripped snapshot of upstream outputs; the
  // code's return value becomes this node's output.
  const codeCfg = asNodeConfig(cfg, "code");
  const snapshot: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (!k.startsWith("__")) snapshot[k] = v;
  }
  const result = await callCode(
    codeCfg,
    { input: ctx.__input, ctx: snapshot },
    metaFor(node.id),
  );
  ctx[node.id] = result.result;
  return;
};
