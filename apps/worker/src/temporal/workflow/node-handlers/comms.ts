// Email + sandboxed-code leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE: binding
// resolution is pure + in-workflow; the SMTP send / QuickJS execution run in the SAME
// activity proxies run-graph.ts uses. sendEmail returns its `costUsd` DELTA.
import {
  resolveSendEmail,
  asNodeConfig,
  renderEmailHtml,
  resolveTemplateString,
} from "@naary/dsl/dist/workflow";
import type { NodeOutputMap } from "@naary/dsl";
import { callSendEmail, callCode, loadTemplate } from "../proxies";
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
  let resolved = resolveSendEmail(emailCfg, ctx);

  // A referenced content template DEFINES the body: load its blocks (in-activity — the id, never
  // the blocks, rides the graph) and render them against ctx. `renderEmailHtml` is pure and escapes
  // every interpolated value, so this stays deterministic workflow code (Tier-1 §2). The rendered
  // html replaces the inline body (text dropped). Falls back to the inline body if the template was
  // deleted (loadTemplate → null). See docs/design/TEMPLATE-EDITOR.md.
  if (emailCfg.templateId) {
    const tmpl = await loadTemplate(emailCfg.templateId, metaFor(node.id));
    if (tmpl) {
      const subject =
        tmpl.subject != null
          ? resolveTemplateString(tmpl.subject, ctx)
          : undefined;
      resolved = {
        ...resolved,
        html: renderEmailHtml(tmpl.blocks, ctx),
        text: undefined, // the template html is the body
        ...(subject !== undefined
          ? { subject: typeof subject === "string" ? subject : String(subject) }
          : {}),
      };
    }
  }

  const result = await callSendEmail(resolved, ctx.__input, metaFor(node.id));
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
